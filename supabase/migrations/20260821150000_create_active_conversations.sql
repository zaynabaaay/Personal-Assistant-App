-- Active conversations are durable owner-scoped drafts. They remain separate
-- from completed History until finalize_active_conversation moves them there.

create table public.active_conversations (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  started_at timestamptz not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  revision integer not null default 0 check (revision >= 0 and revision <= 50),
  unique (owner_id, id)
);

create table public.active_conversation_messages (
  owner_id uuid not null default auth.uid(),
  id text not null,
  conversation_id text not null,
  position integer not null check (position >= 0 and position < 50),
  role text not null check (role in ('user', 'assistant')),
  content text not null check (length(content) > 0 and length(content) <= 4000),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, id),
  unique (owner_id, conversation_id, position),
  foreign key (owner_id, conversation_id)
    references public.active_conversations(owner_id, id) on delete cascade
);

create index active_conversation_messages_order_idx
  on public.active_conversation_messages(owner_id, conversation_id, position, id);

alter table public.active_conversations enable row level security;
alter table public.active_conversation_messages enable row level security;

create policy active_conversations_owner_access
  on public.active_conversations for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy active_conversation_messages_owner_access
  on public.active_conversation_messages for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

revoke all on table public.active_conversations from public, anon, authenticated;
revoke all on table public.active_conversation_messages from public, anon, authenticated;
grant select on table public.active_conversations to authenticated;
grant select on table public.active_conversation_messages to authenticated;

create function public.save_active_conversation(
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
  existing_conversation_id text;
  existing_started_at timestamptz;
  existing_created_at timestamptz;
  supplied_message_count integer;
  stored_message_count integer;
  mismatched_message_count integer;
  distinct_message_id_count integer;
  distinct_position_count integer;
  minimum_position integer;
  maximum_position integer;
  message jsonb;
begin
  if authenticated_owner is null then
    raise exception 'Saving an active conversation requires an authenticated user.'
      using errcode = '42501';
  end if;
  if jsonb_typeof(p_conversation) <> 'object' or jsonb_typeof(p_messages) <> 'array' then
    raise exception 'The active conversation payload is invalid.';
  end if;

  target_conversation_id := nullif(btrim(p_conversation->>'id'), '');
  supplied_message_count := jsonb_array_length(p_messages);
  if target_conversation_id is null or supplied_message_count < 1 or supplied_message_count > 50 then
    raise exception 'The active conversation payload is incomplete.';
  end if;
  if (select coalesce(sum(length(value->>'content')), 0)
      from jsonb_array_elements(p_messages)) > 30000 then
    raise exception 'The active conversation transcript is too large.';
  end if;

  select count(distinct value->>'id'), count(distinct (value->>'position')::integer),
    min((value->>'position')::integer), max((value->>'position')::integer)
  into distinct_message_id_count, distinct_position_count, minimum_position, maximum_position
  from jsonb_array_elements(p_messages);
  if distinct_message_id_count <> supplied_message_count
    or distinct_position_count <> supplied_message_count
    or minimum_position <> 0 or maximum_position <> supplied_message_count - 1
    or exists (
      select 1 from jsonb_array_elements(p_messages) supplied
      where nullif(btrim(supplied.value->>'id'), '') is null
        or supplied.value->>'conversation_id' is distinct from target_conversation_id
        or supplied.value->>'role' not in ('user', 'assistant')
        or length(coalesce(supplied.value->>'content', '')) < 1
        or length(supplied.value->>'content') > 4000
        or (supplied.value->>'occurred_at')::timestamptz is null
    ) then
    raise exception 'The active conversation transcript is invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(authenticated_owner::text || ':active-conversation', 0)
  );
  select id, started_at, created_at
  into existing_conversation_id, existing_started_at, existing_created_at
  from public.active_conversations
  where owner_id = authenticated_owner
  for update;

  if existing_conversation_id is null then
    insert into public.active_conversations (
      owner_id, id, started_at, created_at, updated_at, revision
    ) values (
      authenticated_owner, target_conversation_id,
      (p_conversation->>'started_at')::timestamptz,
      (p_conversation->>'created_at')::timestamptz,
      now(), 0
    );
  elsif existing_conversation_id is distinct from target_conversation_id then
    raise exception 'Another active conversation already exists.' using errcode = '40001';
  elsif existing_started_at is distinct from (p_conversation->>'started_at')::timestamptz
    or existing_created_at is distinct from (p_conversation->>'created_at')::timestamptz then
    raise exception 'The active conversation identity conflicts with the stored draft.'
      using errcode = '40001';
  end if;

  select count(*) into stored_message_count
  from public.active_conversation_messages
  where owner_id = authenticated_owner and conversation_id = target_conversation_id;

  select count(*) into mismatched_message_count
  from jsonb_array_elements(p_messages) supplied
  join public.active_conversation_messages stored
    on stored.owner_id = authenticated_owner
    and stored.conversation_id = target_conversation_id
    and stored.position = (supplied.value->>'position')::integer
  where (supplied.value->>'position')::integer < stored_message_count
    and (
      stored.id is distinct from supplied.value->>'id'
      or stored.role is distinct from supplied.value->>'role'
      or stored.content is distinct from supplied.value->>'content'
      or stored.occurred_at is distinct from (supplied.value->>'occurred_at')::timestamptz
    );
  if mismatched_message_count > 0 then
    raise exception 'The active conversation changed in another session.' using errcode = '40001';
  end if;

  if supplied_message_count > stored_message_count then
    for message in
      select value from jsonb_array_elements(p_messages)
      where (value->>'position')::integer >= stored_message_count
      order by (value->>'position')::integer
    loop
      insert into public.active_conversation_messages (
        owner_id, id, conversation_id, position, role, content, occurred_at
      ) values (
        authenticated_owner, message->>'id', target_conversation_id,
        (message->>'position')::integer, message->>'role', message->>'content',
        (message->>'occurred_at')::timestamptz
      );
    end loop;
  end if;

  update public.active_conversations
  set revision = greatest(revision, supplied_message_count), updated_at = now()
  where owner_id = authenticated_owner and id = target_conversation_id;
end;
$function$;

create function public.finalize_active_conversation(p_conversation jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_owner uuid := auth.uid();
  target_conversation_id text;
  active_conversation_id text;
  supplied_message_count integer;
  stored_message_count integer;
  completed_message_count integer;
  mismatched_message_count integer;
begin
  if authenticated_owner is null then
    raise exception 'Finalizing a conversation requires an authenticated user.'
      using errcode = '42501';
  end if;
  if jsonb_typeof(p_conversation) <> 'object' then
    raise exception 'The completed conversation payload is invalid.';
  end if;
  target_conversation_id := nullif(btrim(p_conversation->>'id'), '');
  supplied_message_count := (p_conversation->>'message_count')::integer;
  if target_conversation_id is null or supplied_message_count < 1 or supplied_message_count > 50 then
    raise exception 'The completed conversation payload is incomplete.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(authenticated_owner::text || ':active-conversation', 0)
  );
  select id into active_conversation_id
  from public.active_conversations
  where owner_id = authenticated_owner
  for update;

  if active_conversation_id is null then
    if exists (
      select 1 from public.completed_conversations
      where owner_id = authenticated_owner and id = target_conversation_id
    ) then
      return;
    end if;
    raise exception 'The active conversation was not found.';
  end if;
  if active_conversation_id is distinct from target_conversation_id then
    raise exception 'Another active conversation already exists.' using errcode = '40001';
  end if;

  select count(*) into stored_message_count
  from public.active_conversation_messages
  where owner_id = authenticated_owner and conversation_id = target_conversation_id;
  if stored_message_count <> supplied_message_count then
    raise exception 'The active conversation changed before it could be finalized.'
      using errcode = '40001';
  end if;

  if exists (
    select 1 from public.completed_conversations
    where owner_id = authenticated_owner and id = target_conversation_id
  ) then
    select count(*) into completed_message_count
    from public.conversation_messages
    where owner_id = authenticated_owner and conversation_id = target_conversation_id;
    select count(*) into mismatched_message_count
    from public.active_conversation_messages active
    join public.conversation_messages completed
      on completed.owner_id = authenticated_owner
      and completed.conversation_id = target_conversation_id
      and completed.position = active.position
    where active.owner_id = authenticated_owner
      and active.conversation_id = target_conversation_id
      and (
        completed.id is distinct from active.id or completed.role is distinct from active.role
        or completed.content is distinct from active.content
        or completed.occurred_at is distinct from active.occurred_at
      );
    if completed_message_count <> stored_message_count or mismatched_message_count > 0 then
      raise exception 'A different completed transcript already uses this conversation ID.';
    end if;
  else
    insert into public.completed_conversations (
      owner_id, id, started_at, completed_at, title, summary, status,
      metadata_status, processing_status, processing_attempts, message_count,
      created_at, updated_at
    ) values (
      authenticated_owner, target_conversation_id,
      (p_conversation->>'started_at')::timestamptz,
      (p_conversation->>'completed_at')::timestamptz,
      p_conversation->>'title', p_conversation->>'summary', 'completed',
      p_conversation->>'metadata_status', 'pending', 0, supplied_message_count,
      (p_conversation->>'created_at')::timestamptz,
      (p_conversation->>'updated_at')::timestamptz
    );

    insert into public.conversation_messages (
      owner_id, id, conversation_id, position, role, content, occurred_at
    ) select
      owner_id, id, conversation_id, position, role, content, occurred_at
    from public.active_conversation_messages
    where owner_id = authenticated_owner and conversation_id = target_conversation_id
    order by position, id;
  end if;

  delete from public.active_conversations
  where owner_id = authenticated_owner and id = target_conversation_id;
end;
$function$;

revoke all on function public.save_active_conversation(jsonb, jsonb) from public, anon;
revoke all on function public.finalize_active_conversation(jsonb) from public, anon;
grant execute on function public.save_active_conversation(jsonb, jsonb) to authenticated;
grant execute on function public.finalize_active_conversation(jsonb) to authenticated;
