-- Completed conversations are historical source material. Active conversations stay
-- local until Finish Conversation commits the transcript through the atomic RPC below.

create table public.completed_conversations (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  title text not null,
  summary text not null,
  status text not null default 'completed' check (status = 'completed'),
  metadata_status text not null check (metadata_status in ('fallback', 'generated')),
  processing_status text not null default 'pending'
    check (processing_status in ('pending', 'processing', 'processed', 'failed')),
  processing_attempts integer not null default 0 check (processing_attempts >= 0),
  last_processing_error text,
  processing_plan jsonb,
  message_count integer not null check (message_count > 0),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (owner_id, id),
  check (completed_at >= started_at)
);

create table public.conversation_messages (
  owner_id uuid not null default auth.uid(),
  id text not null,
  conversation_id text not null,
  position integer not null check (position >= 0),
  role text not null check (role in ('user', 'assistant')),
  content text not null check (length(content) > 0 and length(content) <= 4000),
  occurred_at timestamptz not null,
  primary key (owner_id, id),
  unique (owner_id, conversation_id, position),
  foreign key (owner_id, conversation_id)
    references public.completed_conversations(owner_id, id) on delete cascade
);

create index completed_conversations_history_idx
  on public.completed_conversations(owner_id, completed_at desc, id);
create index conversation_messages_transcript_idx
  on public.conversation_messages(owner_id, conversation_id, position, id);

alter table public.completed_conversations enable row level security;
alter table public.conversation_messages enable row level security;

create policy completed_conversations_owner_access
  on public.completed_conversations for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy conversation_messages_owner_access
  on public.conversation_messages for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

revoke all on table public.completed_conversations from anon;
revoke all on table public.conversation_messages from anon;
grant select on table public.completed_conversations to authenticated;
grant select on table public.conversation_messages to authenticated;

-- The function is one transaction. It derives ownership only from the verified JWT,
-- rejects a reused ID with different content, and treats an exact retry as success.
create function public.complete_conversation(
  p_conversation jsonb,
  p_messages jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_owner uuid := auth.uid();
  target_conversation_id text;
  supplied_message_count integer;
  stored_message_count integer;
  mismatched_message_count integer;
  distinct_position_count integer;
  minimum_position integer;
  maximum_position integer;
  message jsonb;
begin
  if authenticated_owner is null then
    raise exception 'Completing a conversation requires an authenticated user.'
      using errcode = '42501';
  end if;

  if jsonb_typeof(p_conversation) <> 'object' or jsonb_typeof(p_messages) <> 'array' then
    raise exception 'The completed conversation payload is invalid.';
  end if;

  target_conversation_id := nullif(btrim(p_conversation->>'id'), '');
  supplied_message_count := jsonb_array_length(p_messages);

  if target_conversation_id is null or supplied_message_count < 1
    or supplied_message_count > 50
    or supplied_message_count <> (p_conversation->>'message_count')::integer then
    raise exception 'The completed conversation payload is incomplete.';
  end if;

  if (select coalesce(sum(length(value->>'content')), 0)
      from jsonb_array_elements(p_messages)) > 30000 then
    raise exception 'The completed conversation transcript is too large.';
  end if;

  select count(distinct (value->>'position')::integer),
    min((value->>'position')::integer), max((value->>'position')::integer)
  into distinct_position_count, minimum_position, maximum_position
  from jsonb_array_elements(p_messages);

  if distinct_position_count <> supplied_message_count or minimum_position <> 0
    or maximum_position <> supplied_message_count - 1 then
    raise exception 'Conversation message positions must be contiguous.';
  end if;

  if exists (
    select 1 from public.completed_conversations
    where owner_id = authenticated_owner and id = target_conversation_id
  ) then
    select count(*) into stored_message_count
    from public.conversation_messages
    where owner_id = authenticated_owner and conversation_id = target_conversation_id;

    select count(*) into mismatched_message_count
    from jsonb_array_elements(p_messages) supplied
    left join public.conversation_messages stored
      on stored.owner_id = authenticated_owner
      and stored.conversation_id = target_conversation_id
      and stored.id = supplied.value->>'id'
      and stored.position = (supplied.value->>'position')::integer
      and stored.role = supplied.value->>'role'
      and stored.content = supplied.value->>'content'
      and stored.occurred_at = (supplied.value->>'occurred_at')::timestamptz
    where stored.id is null;

    if stored_message_count <> supplied_message_count or mismatched_message_count > 0 then
      raise exception 'A different transcript already uses this conversation ID.';
    end if;

    return;
  end if;

  insert into public.completed_conversations (
    owner_id, id, started_at, completed_at, title, summary, status,
    metadata_status, processing_status, processing_attempts, message_count,
    created_at, updated_at
  ) values (
    authenticated_owner,
    target_conversation_id,
    (p_conversation->>'started_at')::timestamptz,
    (p_conversation->>'completed_at')::timestamptz,
    p_conversation->>'title',
    p_conversation->>'summary',
    'completed',
    p_conversation->>'metadata_status',
    'pending',
    0,
    supplied_message_count,
    (p_conversation->>'created_at')::timestamptz,
    (p_conversation->>'updated_at')::timestamptz
  );

  for message in select value from jsonb_array_elements(p_messages)
  loop
    if message->>'conversation_id' is distinct from target_conversation_id then
      raise exception 'A message belongs to a different conversation.';
    end if;

    insert into public.conversation_messages (
      owner_id, id, conversation_id, position, role, content, occurred_at
    ) values (
      authenticated_owner,
      message->>'id',
      target_conversation_id,
      (message->>'position')::integer,
      message->>'role',
      message->>'content',
      (message->>'occurred_at')::timestamptz
    );
  end loop;

  select count(*) into stored_message_count
  from public.conversation_messages
  where owner_id = authenticated_owner
    and conversation_id = target_conversation_id;

  if stored_message_count <> supplied_message_count then
    raise exception 'The completed transcript was not stored in full.';
  end if;
end;
$function$;

revoke all on function public.complete_conversation(jsonb, jsonb) from public, anon;
grant execute on function public.complete_conversation(jsonb, jsonb) to authenticated;
