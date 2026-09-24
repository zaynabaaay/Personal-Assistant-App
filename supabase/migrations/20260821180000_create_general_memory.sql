-- Small, owner-scoped general memory. Raw conversations remain the evidence
-- source and Projects remain a separate authority for Project-specific truth.

-- This function is the authoritative structural identity contract for memory
-- subjects and contexts. It deliberately normalizes formatting, not meaning.
create function public.canonical_general_memory_identity(
  p_value text,
  p_component text default 'subject'
) returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $function$
declare normalized text;
begin
  if p_component not in ('subject', 'context') then
    raise exception 'The memory identity component is invalid.';
  end if;
  normalized := pg_catalog.lower(pg_catalog.btrim(pg_catalog.translate(
    coalesce(p_value, ''), '–—：', '--:'
  )));
  normalized := pg_catalog.regexp_replace(normalized, '[[:space:]]+', ' ', 'g');
  if p_component = 'subject' then
    -- Subject keys use punctuation as structural separators. Treat common
    -- formatting variants as the same separator without fuzzy word matching.
    normalized := pg_catalog.regexp_replace(
      normalized, '[[:space:]]*[:|/._-]+[[:space:]]*', ':', 'g'
    );
    normalized := pg_catalog.btrim(normalized, ':');
  else
    -- Context is natural language, so preserve punctuation and only normalize
    -- spacing around separators whose meaning is not changed by that spacing.
    normalized := pg_catalog.regexp_replace(
      normalized, '[[:space:]]*([:/|])[[:space:]]*', '\1', 'g'
    );
  end if;
  return normalized;
end;
$function$;

create function public.general_memory_provenance_rank(p_provenance text)
returns integer
language sql
immutable
parallel safe
set search_path = ''
return case p_provenance
  when 'explicit_decision' then 3
  when 'explicit_statement' then 2
  when 'inferred' then 1
  else 0
end;

create table public.general_memories (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  layer text not null check (layer in ('durable', 'current_state')),
  memory_type text not null check (
    memory_type in ('background', 'commitment', 'constraint', 'goal', 'preference', 'state')
  ),
  subject_key text not null check (length(btrim(subject_key)) between 1 and 160),
  subject_identity text generated always as (
    public.canonical_general_memory_identity(subject_key, 'subject')
  ) stored,
  topic text check (topic is null or length(topic) <= 160),
  content text not null check (length(btrim(content)) between 1 and 600),
  context text check (context is null or length(context) <= 300),
  context_identity text generated always as (
    public.canonical_general_memory_identity(context, 'context')
  ) stored,
  status text not null check (status in ('current', 'stale', 'superseded', 'expired', 'ambiguous')),
  confidence double precision not null check (confidence between 0 and 1),
  provenance text not null check (
    provenance in ('explicit_statement', 'explicit_decision', 'inferred')
  ),
  source_references jsonb not null default '[]'::jsonb check (jsonb_typeof(source_references) = 'array'),
  evidence_count integer not null default 1 check (evidence_count between 1 and 10000),
  supersedes_memory_id text,
  superseded_by_memory_id text,
  valid_from timestamptz,
  valid_until timestamptz,
  stale_after timestamptz,
  last_confirmed_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(subject_key, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(topic, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(context, '')), 'C')
  ) stored,
  primary key (owner_id, id),
  foreign key (owner_id, supersedes_memory_id)
    references public.general_memories(owner_id, id),
  foreign key (owner_id, superseded_by_memory_id)
    references public.general_memories(owner_id, id),
  check (valid_from is null or valid_until is null or valid_until >= valid_from),
  check (layer <> 'current_state' or valid_until is not null or stale_after is not null)
);

create table public.memory_message_processing (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  message_id text not null,
  conversation_id text not null,
  status text not null check (status in ('processing', 'processed', 'failed')),
  processing_attempts integer not null default 0 check (processing_attempts between 0 and 20),
  last_error text check (last_error is null or length(last_error) <= 1000),
  processed_at timestamptz,
  claim_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, message_id)
);

create index general_memories_search_idx on public.general_memories using gin(search_vector);
create index general_memories_subject_idx
  on public.general_memories(owner_id, subject_identity, context_identity, status, updated_at desc);
create index general_memories_currentness_idx
  on public.general_memories(owner_id, layer, status, stale_after, valid_until);
create index general_memories_analysis_recent_idx
  on public.general_memories(owner_id, updated_at desc)
  where status <> 'superseded';
create index memory_message_processing_conversation_idx
  on public.memory_message_processing(owner_id, conversation_id, status, updated_at);

alter table public.general_memories enable row level security;
alter table public.memory_message_processing enable row level security;

create policy general_memories_owner_access
  on public.general_memories for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy memory_message_processing_owner_access
  on public.memory_message_processing for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

revoke all on table public.general_memories from public, anon, authenticated;
revoke all on table public.memory_message_processing from public, anon, authenticated;
grant select on table public.general_memories to authenticated;

create function public.claim_next_memory_message(p_conversation_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_owner uuid := auth.uid();
  target record;
  existing_status text;
  existing_updated_at timestamptz;
  nearby jsonb;
  claim_token_value text;
begin
  if authenticated_owner is null then
    raise exception 'Memory processing requires an authenticated user.' using errcode = '42501';
  end if;
  if p_conversation_id is not null and (
    length(btrim(p_conversation_id)) < 1 or length(p_conversation_id) > 300
  ) then
    raise exception 'The memory conversation ID is invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(authenticated_owner::text || ':memory-claim', 0)
  );

  select messages.* into target
  from (
    select id, conversation_id, position, role, content, occurred_at
    from public.active_conversation_messages
    where owner_id = authenticated_owner
    union all
    select id, conversation_id, position, role, content, occurred_at
    from public.conversation_messages
    where owner_id = authenticated_owner
  ) messages
  left join public.memory_message_processing processing
    on processing.owner_id = authenticated_owner and processing.message_id = messages.id
  where messages.role = 'user' and coalesce(processing.status, '') <> 'processed'
  order by case when p_conversation_id is not null
      and messages.conversation_id = p_conversation_id then 0 else 1 end,
    messages.occurred_at, messages.conversation_id, messages.position, messages.id
  limit 1;

  if target.id is null then
    return jsonb_build_object('status', 'complete');
  end if;

  select status, updated_at into existing_status, existing_updated_at
  from public.memory_message_processing
  where owner_id = authenticated_owner and message_id = target.id
  for update;
  if existing_status = 'processing' and existing_updated_at > now() - interval '2 minutes' then
    return jsonb_build_object('status', 'processing');
  end if;

  claim_token_value := pg_catalog.md5(
    authenticated_owner::text || ':' || target.id || ':' || clock_timestamp()::text || ':' || random()::text
  );

  insert into public.memory_message_processing (
    owner_id, message_id, conversation_id, status, processing_attempts, last_error,
    claim_token, updated_at
  ) values (
    authenticated_owner, target.id, target.conversation_id, 'processing', 1, null,
    claim_token_value, now()
  ) on conflict (owner_id, message_id) do update set
    status = 'processing',
    processing_attempts = least(public.memory_message_processing.processing_attempts + 1, 20),
    last_error = null,
    claim_token = claim_token_value,
    updated_at = now();

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', messages.id,
    'content', messages.content,
    'occurredAt', messages.occurred_at,
    'position', messages.position,
    'role', messages.role
  ) order by messages.position, messages.id), '[]'::jsonb) into nearby
  from (
    select id, position, role, content, occurred_at
    from public.active_conversation_messages
    where owner_id = authenticated_owner and conversation_id = target.conversation_id
    union all
    select id, position, role, content, occurred_at
    from public.conversation_messages
    where owner_id = authenticated_owner and conversation_id = target.conversation_id
  ) messages
  where messages.position between greatest(target.position - 3, 0) and target.position + 3;

  return jsonb_build_object(
    'status', 'claimed',
    'claimToken', claim_token_value,
    'context', jsonb_build_object(
      'conversationId', target.conversation_id,
      'message', jsonb_build_object(
        'id', target.id,
        'conversationId', target.conversation_id,
        'content', target.content,
        'occurredAt', target.occurred_at,
        'position', target.position,
        'role', 'user'
      ),
      'nearbyMessages', nearby
    )
  );
end;
$function$;

create function public.commit_memory_analysis(
  p_conversation_id text,
  p_message_id text,
  p_claim_token text,
  p_expected_memories jsonb,
  p_analysis jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_owner uuid := auth.uid();
  source_message record;
  candidate jsonb;
  candidate_index integer := 0;
  candidate_id text;
  candidate_action text;
  candidate_status text;
  candidate_confidence double precision;
  existing_memory public.general_memories%rowtype;
  duplicate_memory public.general_memories%rowtype;
  source_reference jsonb;
  subject_lock record;
  checkpoint record;
  candidate_context text;
  candidate_subject text;
  candidate_provenance_rank integer;
  affected_count integer;
begin
  if authenticated_owner is null then
    raise exception 'Memory processing requires an authenticated user.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_analysis) <> 'object' or (p_analysis->>'version')::integer <> 1
    or jsonb_typeof(p_analysis->'candidates') <> 'array'
    or jsonb_array_length(p_analysis->'candidates') > 6 then
    raise exception 'The memory analysis is invalid.';
  end if;
  if p_claim_token is null or length(p_claim_token) < 16
    or jsonb_typeof(p_expected_memories) <> 'array'
    or jsonb_array_length(p_expected_memories) > 12 then
    raise exception 'The memory commit precondition is invalid.';
  end if;

  select status, claim_token into checkpoint
  from public.memory_message_processing
  where owner_id = authenticated_owner and conversation_id = p_conversation_id
    and message_id = p_message_id
  for update;
  if checkpoint.status is distinct from 'processing'
    or checkpoint.claim_token is distinct from p_claim_token then
    raise exception 'The memory claim is stale.' using errcode = '40001';
  end if;

  -- Subject/context locks cross conversation boundaries. Sorting prevents
  -- deadlocks when one analysis contains several subjects.
  for subject_lock in
    select distinct
      public.canonical_general_memory_identity(value->>'subjectKey', 'subject') as subject_key,
      public.canonical_general_memory_identity(value->>'context', 'context') as context_key
    from jsonb_array_elements(p_analysis->'candidates')
    where value->>'action' <> 'history_only' and value->>'scope' <> 'project'
    order by 1, 2
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      authenticated_owner::text || ':memory-subject:' ||
      length(subject_lock.subject_key)::text || ':' || subject_lock.subject_key || ':' ||
      length(subject_lock.context_key)::text || ':' || subject_lock.context_key, 0
    ));
  end loop;

  select messages.* into source_message from (
    select id, conversation_id, position, role, content, occurred_at
    from public.active_conversation_messages
    where owner_id = authenticated_owner and conversation_id = p_conversation_id
    union all
    select id, conversation_id, position, role, content, occurred_at
    from public.conversation_messages
    where owner_id = authenticated_owner and conversation_id = p_conversation_id
  ) messages where messages.id = p_message_id and messages.role = 'user' limit 1;
  if source_message.id is null then raise exception 'Memory source evidence was not found.'; end if;
  source_reference := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'message_id', p_message_id,
    'occurred_at', source_message.occurred_at,
    'role', 'user'
  );

  -- The model result is valid only for the active subject snapshots it saw.
  -- Re-read after taking the subject locks and reject any addition, removal, or
  -- version/status/provenance change so the message can be analyzed again.
  for subject_lock in
    select distinct
      public.canonical_general_memory_identity(value->>'subjectKey', 'subject') as subject_key,
      public.canonical_general_memory_identity(value->>'context', 'context') as context_key
    from jsonb_array_elements(p_analysis->'candidates')
    where value->>'action' <> 'history_only' and value->>'scope' <> 'project'
  loop
    if exists (
      select 1 from public.general_memories memory
      where memory.owner_id = authenticated_owner
        and memory.status in ('current', 'ambiguous', 'stale')
        and memory.subject_identity = subject_lock.subject_key
        and memory.context_identity = subject_lock.context_key
        and not exists (
          select 1 from jsonb_array_elements(p_expected_memories) expected
          where expected->>'id' = memory.id
            and public.canonical_general_memory_identity(
              expected->>'subjectKey', 'subject'
            ) = subject_lock.subject_key
            and public.canonical_general_memory_identity(
              expected->>'context', 'context'
            ) = subject_lock.context_key
            and expected->>'content' = memory.content
            and expected->>'provenance' = memory.provenance
            and (expected->>'updatedAt')::timestamptz = memory.updated_at
            and expected->>'status' = case
              when memory.status = 'current' and memory.valid_from is not null
                and memory.valid_from > now() then 'stale'
              when memory.status = 'current' and memory.valid_until is not null
                and memory.valid_until < now() then 'expired'
              when memory.status = 'current' and memory.stale_after is not null
                and memory.stale_after < now() then 'stale'
              else memory.status end
        )
    ) or exists (
      select 1 from jsonb_array_elements(p_expected_memories) expected
      where public.canonical_general_memory_identity(
          expected->>'subjectKey', 'subject'
        ) = subject_lock.subject_key
        and public.canonical_general_memory_identity(
          expected->>'context', 'context'
        ) = subject_lock.context_key
        and expected->>'status' in ('current', 'ambiguous', 'stale', 'expired')
        and not exists (
          select 1 from public.general_memories memory
          where memory.owner_id = authenticated_owner and memory.id = expected->>'id'
            and memory.status in ('current', 'ambiguous', 'stale')
            and memory.content = expected->>'content'
            and memory.provenance = expected->>'provenance'
            and memory.updated_at = (expected->>'updatedAt')::timestamptz
        )
    ) then
      raise exception 'Memory analysis is stale and must be retried.' using errcode = '40001';
    end if;
  end loop;

  for candidate in select value from jsonb_array_elements(p_analysis->'candidates') loop
    candidate_index := candidate_index + 1;
    candidate_action := candidate->>'action';
    if candidate_action = 'history_only' or candidate->>'scope' = 'project' then continue; end if;
    if candidate_action not in ('promote', 'repeat', 'supersede', 'exception', 'coexist', 'ambiguous')
      or candidate->>'layer' not in ('durable', 'current_state')
      or candidate->>'memoryType' not in ('background', 'commitment', 'constraint', 'goal', 'preference', 'state')
      or candidate->>'provenance' not in ('explicit_statement', 'explicit_decision', 'inferred')
      or candidate->>'scope' <> 'general'
      or length(btrim(coalesce(candidate->>'subjectKey', ''))) not between 1 and 160
      or length(btrim(coalesce(candidate->>'content', ''))) not between 1 and 600 then
      raise exception 'A memory candidate is invalid.';
    end if;
    if candidate_action = 'exception' and nullif(btrim(candidate->>'context'), '') is null then
      raise exception 'A contextual exception requires context.';
    end if;
    candidate_confidence := greatest(0, least(
      case when candidate->>'provenance' = 'inferred' then 0.65 else 1 end,
      (candidate->>'confidence')::double precision
    ));
    candidate_subject := public.canonical_general_memory_identity(
      candidate->>'subjectKey', 'subject'
    );
    candidate_context := public.canonical_general_memory_identity(
      candidate->>'context', 'context'
    );
    candidate_provenance_rank := public.general_memory_provenance_rank(
      candidate->>'provenance'
    );
    if nullif(candidate->>'validFrom', '') is not null
      and nullif(candidate->>'validUntil', '') is not null
      and (candidate->>'validUntil')::timestamptz < (candidate->>'validFrom')::timestamptz then
      raise exception 'The memory validity range is invalid.';
    end if;

    existing_memory := null;
    if nullif(candidate->>'existingMemoryId', '') is not null then
      select * into existing_memory from public.general_memories
      where owner_id = authenticated_owner and id = candidate->>'existingMemoryId'
      for update;
    end if;

    if candidate_action in ('repeat', 'supersede') and existing_memory.id is null then
      raise exception 'The referenced memory was not found.';
    end if;
    if candidate_action in ('repeat', 'supersede') and (
      existing_memory.subject_identity is distinct from candidate_subject
      or existing_memory.context_identity is distinct from candidate_context
    ) then
      raise exception 'The referenced memory has a different logical identity.';
    end if;

    if candidate_action = 'repeat' then
      if existing_memory.status not in ('current', 'ambiguous', 'stale') then
        raise exception 'Only active memory can be repeated.' using errcode = '40001';
      end if;
      update public.general_memories set
        confidence = case when candidate_provenance_rank >=
          public.general_memory_provenance_rank(provenance)
          then greatest(confidence, candidate_confidence) else confidence end,
        evidence_count = least(evidence_count + case
          when source_references @> jsonb_build_array(source_reference) then 0 else 1 end, 10000),
        source_references = case
          when source_references @> jsonb_build_array(source_reference) then source_references
          when jsonb_array_length(source_references) < 20
            then source_references || jsonb_build_array(source_reference)
          else (source_references - 0) || jsonb_build_array(source_reference) end,
        last_confirmed_at = greatest(last_confirmed_at, source_message.occurred_at),
        provenance = case when candidate_provenance_rank >
          public.general_memory_provenance_rank(provenance)
          then candidate->>'provenance' else provenance end,
        status = case when status = 'ambiguous' and candidate_provenance_rank >= 2
          then 'current' else status end,
        updated_at = now()
      where owner_id = authenticated_owner and id = existing_memory.id;
      continue;
    end if;

    select * into duplicate_memory from public.general_memories
    where owner_id = authenticated_owner
      and status in ('current', 'ambiguous')
      and subject_identity = candidate_subject
      and lower(btrim(content)) = lower(btrim(candidate->>'content'))
      and context_identity = candidate_context
    order by updated_at desc limit 1 for update;
    if duplicate_memory.id is not null then
      update public.general_memories set
        confidence = case when candidate_provenance_rank >=
          public.general_memory_provenance_rank(provenance)
          then greatest(confidence, candidate_confidence) else confidence end,
        evidence_count = least(evidence_count + case
          when source_references @> jsonb_build_array(source_reference) then 0 else 1 end, 10000),
        source_references = case
          when source_references @> jsonb_build_array(source_reference) then source_references
          when jsonb_array_length(source_references) < 20
            then source_references || jsonb_build_array(source_reference)
          else (source_references - 0) || jsonb_build_array(source_reference) end,
        last_confirmed_at = greatest(last_confirmed_at, source_message.occurred_at),
        provenance = case when candidate_provenance_rank >
          public.general_memory_provenance_rank(provenance)
          then candidate->>'provenance' else provenance end,
        status = case when status = 'ambiguous' and candidate_provenance_rank >= 2
          then 'current' else status end,
        updated_at = now()
      where owner_id = authenticated_owner and id = duplicate_memory.id;

      if candidate_action = 'supersede' then
        if exists (
          select 1 from public.general_memories
          where owner_id = authenticated_owner and status in ('current', 'ambiguous', 'stale')
            and subject_identity = candidate_subject
            and context_identity = candidate_context
            and public.general_memory_provenance_rank(provenance) > candidate_provenance_rank
            and id <> duplicate_memory.id
            and lower(btrim(content)) <> lower(btrim(candidate->>'content'))
        ) then raise exception 'Memory cannot supersede higher-authority evidence.'; end if;
        update public.general_memories set status = 'superseded',
          superseded_by_memory_id = duplicate_memory.id, updated_at = now()
        where owner_id = authenticated_owner and status in ('current', 'ambiguous', 'stale')
          and subject_identity = candidate_subject
          and context_identity = candidate_context
          and id <> duplicate_memory.id
          and lower(btrim(content)) <> lower(btrim(candidate->>'content'));
      end if;
      continue;
    end if;

    if candidate_action = 'supersede' and exists (
      select 1 from public.general_memories
      where owner_id = authenticated_owner and status in ('current', 'ambiguous', 'stale')
        and subject_identity = candidate_subject
        and context_identity = candidate_context
        and public.general_memory_provenance_rank(provenance) > candidate_provenance_rank
        and lower(btrim(content)) <> lower(btrim(candidate->>'content'))
    ) then raise exception 'Memory cannot supersede higher-authority evidence.'; end if;

    if candidate_action not in ('supersede', 'coexist', 'exception', 'ambiguous') and exists (
      select 1 from public.general_memories
      where owner_id = authenticated_owner and status in ('current', 'ambiguous', 'stale')
        and subject_identity = candidate_subject
        and context_identity = candidate_context
        and lower(btrim(content)) <> lower(btrim(candidate->>'content'))
    ) then raise exception 'Conflicting active memory requires fresh reconciliation.' using errcode = '40001';
    end if;

    candidate_id := 'memory:' || pg_catalog.md5(
      authenticated_owner::text || ':' || p_message_id || ':' || candidate_index::text || ':' ||
      candidate_subject || ':' || candidate_context
    );
    candidate_status := case when candidate_action = 'ambiguous' then 'ambiguous' else 'current' end;

    if candidate_action = 'supersede'
      and existing_memory.status not in ('current', 'ambiguous', 'stale') then
      raise exception 'Only an active memory can be superseded.';
    end if;

    insert into public.general_memories (
      owner_id, id, layer, memory_type, subject_key, topic, content, context, status,
      confidence, provenance, source_references, evidence_count, supersedes_memory_id,
      valid_from, valid_until, stale_after, last_confirmed_at, created_at, updated_at
    ) values (
      authenticated_owner, candidate_id, candidate->>'layer', candidate->>'memoryType',
      btrim(candidate->>'subjectKey'), nullif(btrim(candidate->>'topic'), ''),
      btrim(candidate->>'content'), nullif(btrim(candidate->>'context'), ''), candidate_status,
      candidate_confidence, candidate->>'provenance', jsonb_build_array(source_reference), 1,
      case when candidate_action = 'supersede' then existing_memory.id else null end,
      nullif(candidate->>'validFrom', '')::timestamptz,
      nullif(candidate->>'validUntil', '')::timestamptz,
      coalesce(
        nullif(candidate->>'staleAfter', '')::timestamptz,
        case when candidate->>'layer' = 'current_state' or candidate_action = 'exception'
          then source_message.occurred_at + case when candidate_action = 'exception'
            then interval '7 days' else interval '90 days' end else null end
      ),
      source_message.occurred_at, source_message.occurred_at, now()
    ) on conflict (owner_id, id) do nothing;

    if candidate_action = 'supersede' then
      update public.general_memories set
        status = 'superseded', superseded_by_memory_id = candidate_id, updated_at = now()
      where owner_id = authenticated_owner and status in ('current', 'ambiguous', 'stale')
        and subject_identity = candidate_subject
        and context_identity = candidate_context
        and id <> candidate_id
        and lower(btrim(content)) <> lower(btrim(candidate->>'content'));
    end if;
  end loop;

  update public.memory_message_processing set
    status = 'processed', processed_at = now(), last_error = null, updated_at = now()
  where owner_id = authenticated_owner and message_id = p_message_id
    and status = 'processing' and claim_token = p_claim_token;
  get diagnostics affected_count = row_count;
  if affected_count <> 1 then
    raise exception 'The memory claim is stale.' using errcode = '40001';
  end if;
end;
$function$;

create function public.fail_memory_message(
  p_conversation_id text,
  p_message_id text,
  p_claim_token text,
  p_error text
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_owner uuid := auth.uid();
  affected_count integer;
begin
  if authenticated_owner is null then
    raise exception 'Memory processing requires an authenticated user.' using errcode = '42501';
  end if;
  update public.memory_message_processing set
    status = 'failed', last_error = left(coalesce(p_error, 'Memory processing failed.'), 1000),
    updated_at = now()
  where owner_id = authenticated_owner and conversation_id = p_conversation_id
    and message_id = p_message_id and status = 'processing'
    and claim_token = p_claim_token;
  get diagnostics affected_count = row_count;
  if affected_count <> 1 then
    raise exception 'The memory claim is stale.' using errcode = '40001';
  end if;
end;
$function$;

create function public.search_general_memories(
  p_query text,
  p_layer text default 'any',
  p_include_uncertain boolean default false,
  p_limit integer default 8
) returns table (
  id text, layer text, memory_type text, subject_key text, topic text, content text,
  context text, status text, confidence double precision, provenance text,
  source_references jsonb, evidence_count integer, supersedes_memory_id text,
  superseded_by_memory_id text, valid_from timestamptz, valid_until timestamptz,
  stale_after timestamptz, last_confirmed_at timestamptz, created_at timestamptz,
  updated_at timestamptz, relevance double precision
)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare authenticated_owner uuid := auth.uid();
begin
  if authenticated_owner is null then
    raise exception 'Memory search requires an authenticated user.' using errcode = '42501';
  end if;
  if p_query is null or length(btrim(p_query)) < 1 or length(p_query) > 4000
    or p_layer not in ('any', 'durable', 'current_state')
    or p_limit < 1 or p_limit > 12 then raise exception 'The memory search request is invalid.'; end if;

  return query
  with query_value as (
    select websearch_to_tsquery('english', p_query) as value
  ), effective as (
    select memories.*,
      case
        when memories.status = 'current' and memories.valid_from is not null
          and memories.valid_from > now() then 'stale'
        when memories.status = 'current' and memories.valid_until is not null
          and memories.valid_until < now() then 'expired'
        when memories.status = 'current' and memories.stale_after is not null
          and memories.stale_after < now() then 'stale'
        else memories.status
      end as effective_status
    from public.general_memories memories
    where memories.owner_id = authenticated_owner
      and memories.status <> 'superseded'
      and (p_layer = 'any' or memories.layer = p_layer)
  ), scored as (
    select effective.*,
      (ts_rank_cd(effective.search_vector, query_value.value) * 5.0
        + effective.confidence
        + least(effective.evidence_count, 5) * 0.05
        + case when effective.layer = 'current_state' then
          0.25 / (1.0 + greatest(extract(epoch from (now() - effective.updated_at)), 0) / 86400.0 / 30.0)
          else 0 end)::double precision as score
    from effective cross join query_value
    where effective.search_vector @@ query_value.value
      and (p_include_uncertain or effective.effective_status = 'current')
  )
  select scored.id, scored.layer, scored.memory_type, scored.subject_key,
    scored.topic, scored.content, scored.context, scored.effective_status,
    scored.confidence, scored.provenance, scored.source_references,
    scored.evidence_count, scored.supersedes_memory_id,
    scored.superseded_by_memory_id, scored.valid_from, scored.valid_until,
    scored.stale_after, scored.last_confirmed_at, scored.created_at,
    scored.updated_at, scored.score
  from scored
  order by scored.score desc, scored.updated_at desc, scored.id
  limit p_limit;
end;
$function$;

create function public.get_memory_analysis_context(
  p_query text,
  p_limit integer default 12
) returns table (
  id text, layer text, memory_type text, subject_key text, topic text, content text,
  context text, status text, confidence double precision, provenance text,
  source_references jsonb, evidence_count integer, supersedes_memory_id text,
  superseded_by_memory_id text, valid_from timestamptz, valid_until timestamptz,
  stale_after timestamptz, last_confirmed_at timestamptz, created_at timestamptz,
  updated_at timestamptz, relevance double precision
)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare authenticated_owner uuid := auth.uid();
begin
  if authenticated_owner is null then
    raise exception 'Memory analysis context requires an authenticated user.' using errcode = '42501';
  end if;
  if p_query is null or length(btrim(p_query)) < 1 or length(p_query) > 4000
    or p_limit < 1 or p_limit > 12 then raise exception 'The memory context request is invalid.'; end if;

  return query
  with query_value as (
    select websearch_to_tsquery('english', p_query) as value
  ), effective as (
    select memories.*,
      case
        when memories.status = 'current' and memories.valid_from is not null
          and memories.valid_from > now() then 'stale'
        when memories.status = 'current' and memories.valid_until is not null
          and memories.valid_until < now() then 'expired'
        when memories.status = 'current' and memories.stale_after is not null
          and memories.stale_after < now() then 'stale'
        else memories.status
      end as effective_status
    from public.general_memories memories
    where memories.owner_id = authenticated_owner and memories.status <> 'superseded'
  ), scored as (
    select effective.*,
      (effective.search_vector @@ query_value.value) as lexical_match,
      ts_rank_cd(effective.search_vector, query_value.value)::double precision as score,
      (effective.effective_status in ('ambiguous', 'stale', 'expired')
        or effective.provenance = 'inferred') as unresolved
    from effective cross join query_value
  ), lexical as (
    select scored.id from scored where scored.lexical_match
    order by scored.score desc, scored.updated_at desc, scored.id
    limit p_limit
  ), recent_or_unresolved as (
    select effective.id from effective
    where effective.effective_status in ('ambiguous', 'stale', 'expired')
      or effective.provenance = 'inferred'
      or effective.updated_at > now() - interval '180 days'
    order by (effective.effective_status in ('ambiguous', 'stale', 'expired')
      or effective.provenance = 'inferred') desc,
      effective.updated_at desc, effective.id
    limit least(p_limit, 6)
  ), selected as (
    select lexical.id from lexical
    union
    select recent_or_unresolved.id from recent_or_unresolved
  )
  select scored.id, scored.layer, scored.memory_type, scored.subject_key,
    scored.topic, scored.content, scored.context, scored.effective_status,
    scored.confidence, scored.provenance, scored.source_references,
    scored.evidence_count, scored.supersedes_memory_id,
    scored.superseded_by_memory_id, scored.valid_from, scored.valid_until,
    scored.stale_after, scored.last_confirmed_at, scored.created_at,
    scored.updated_at, scored.score
  from scored join selected on selected.id = scored.id
  order by scored.lexical_match desc, scored.unresolved desc,
    scored.score desc, scored.updated_at desc, scored.id
  limit p_limit;
end;
$function$;

revoke all on function public.claim_next_memory_message(text) from public, anon;
revoke all on function public.commit_memory_analysis(text, text, text, jsonb, jsonb) from public, anon;
revoke all on function public.fail_memory_message(text, text, text, text) from public, anon;
revoke all on function public.search_general_memories(text, text, boolean, integer) from public, anon;
revoke all on function public.get_memory_analysis_context(text, integer) from public, anon;
grant execute on function public.claim_next_memory_message(text) to authenticated;
grant execute on function public.commit_memory_analysis(text, text, text, jsonb, jsonb) to authenticated;
grant execute on function public.fail_memory_message(text, text, text, text) to authenticated;
grant execute on function public.search_general_memories(text, text, boolean, integer) to authenticated;
grant execute on function public.get_memory_analysis_context(text, integer) to authenticated;
