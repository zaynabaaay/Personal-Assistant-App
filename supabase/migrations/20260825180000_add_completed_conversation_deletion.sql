-- Backfill legacy timestamp titles once from the first meaningful user message.
-- New chats use the client lifecycle's deterministic content title before insert.
with first_user_message as (
  select distinct on (owner_id, conversation_id)
    owner_id, conversation_id, content
  from public.conversation_messages
  where role = 'user' and length(btrim(content)) > 0
  order by owner_id, conversation_id, position, id
), cleaned as (
  select owner_id, conversation_id, regexp_replace(
    regexp_replace(content,
      '^(please[[:space:]]+)?(can|could|would|will)[[:space:]]+you[[:space:]]+', '', 'i'),
    '^please[[:space:]]+|^remember[[:space:]]+(that[[:space:]]+)?', '', 'i'
  ) as content
  from first_user_message
), title_words as (
  select cleaned.owner_id, cleaned.conversation_id,
    array_agg(matches.word[1] order by matches.ordinality)
      filter (where matches.ordinality <= 6) as words
  from cleaned
  cross join lateral regexp_matches(
    cleaned.content, '[[:alnum:]][[:alnum:]''’&-]*', 'g'
  ) with ordinality as matches(word, ordinality)
  group by cleaned.owner_id, cleaned.conversation_id
)
update public.completed_conversations conversation
set title = case
  when cardinality(title_words.words) = 1 then initcap(title_words.words[1]) || ' Chat'
  else initcap(array_to_string(title_words.words, ' '))
end,
metadata_status = 'fallback'
from title_words
where conversation.owner_id = title_words.owner_id
  and conversation.id = title_words.conversation_id
  and cardinality(title_words.words) > 0
  and (
    conversation.title ~* '^conversation([[:space:]]*[—-]|$)'
    or conversation.title ~ '[0-9]{4}-[0-9]{2}-[0-9]{2}'
  );

-- Delete a completed transcript without rewriting structured memory or Project truth.
-- Ownership is derived only from the authenticated JWT. The function is idempotent
-- for missing/already-deleted chats and performs all provenance cleanup atomically.
create function public.delete_completed_conversation(p_conversation_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_owner uuid := auth.uid();
  chat_exists boolean;
begin
  if authenticated_owner is null then
    raise exception 'Deleting a chat requires an authenticated user.' using errcode = '42501';
  end if;
  if p_conversation_id is null or length(btrim(p_conversation_id)) < 1
    or length(p_conversation_id) > 300 then
    raise exception 'The chat ID is invalid.';
  end if;

  -- Stop a new memory claim from selecting this transcript, then wait for any
  -- already-claimed message commit/failure to finish before provenance cleanup.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(authenticated_owner::text || ':memory-claim', 0)
  );

  select true into chat_exists
  from public.completed_conversations
  where owner_id = authenticated_owner and id = p_conversation_id
  for update;
  if not coalesce(chat_exists, false) then return false; end if;

  perform 1 from public.memory_message_processing
  where owner_id = authenticated_owner and conversation_id = p_conversation_id
  for update;

  -- Preserve Project sessions and all derived Project truth; only their now-invalid
  -- transcript provenance pointer is cleared to satisfy the existing foreign key.
  update public.project_work_sessions
  set source_conversation_id = null
  where owner_id = authenticated_owner and source_conversation_id = p_conversation_id;

  -- Preserve memory rows, confidence, evidence_count, status, and timestamps. Only
  -- source entries that point at this deleted transcript are removed.
  update public.general_memories memory
  set source_references = coalesce((
    select jsonb_agg(reference.value order by reference.ordinality)
    from jsonb_array_elements(memory.source_references) with ordinality as reference(value, ordinality)
    where reference.value->>'conversation_id' is distinct from p_conversation_id
  ), '[]'::jsonb)
  where memory.owner_id = authenticated_owner
    and memory.source_references @> jsonb_build_array(
      jsonb_build_object('conversation_id', p_conversation_id)
    );

  -- Processing checkpoints are operational state, not structured memory.
  delete from public.memory_message_processing
  where owner_id = authenticated_owner and conversation_id = p_conversation_id;

  -- Messages and conversation-only Project processing rows use owner-scoped
  -- ON DELETE CASCADE constraints. Project sessions were detached above.
  delete from public.completed_conversations
  where owner_id = authenticated_owner and id = p_conversation_id;
  return true;
end;
$function$;

revoke all on function public.delete_completed_conversation(text) from public, anon;
grant execute on function public.delete_completed_conversation(text) to authenticated;
