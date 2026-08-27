-- Keep strong all-term lexical retrieval precise, but recover natural personal
-- recall questions when one generic term would otherwise eliminate the match.
create or replace function public.search_general_memories(
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
    or p_limit < 1 or p_limit > 12 then
    raise exception 'The memory search request is invalid.';
  end if;

  return query
  with query_value as (
    select websearch_to_tsquery('english', p_query) as value
  ), query_terms as (
    select distinct terms.term
    from pg_catalog.unnest(
      pg_catalog.tsvector_to_array(pg_catalog.to_tsvector('english', p_query))
    ) terms(term)
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
      effective.search_vector @@ query_value.value as strong_match,
      pg_catalog.ts_rank_cd(effective.search_vector, query_value.value)::double precision
        as strong_rank,
      (select count(*)::integer from query_terms
        where effective.search_vector @@ pg_catalog.plainto_tsquery('english', query_terms.term))
        as matched_terms,
      (select count(*)::integer from query_terms) as total_terms,
      coalesce((select sum(pg_catalog.ts_rank_cd(
          effective.search_vector,
          pg_catalog.plainto_tsquery('english', query_terms.term)
        )) from query_terms
        where effective.search_vector @@ pg_catalog.plainto_tsquery('english', query_terms.term)), 0)
        ::double precision as partial_rank
    from effective cross join query_value
    where p_include_uncertain or effective.effective_status = 'current'
  ), strong as (
    select scored.*,
      (100.0 + scored.strong_rank * 5.0 + scored.confidence
        + least(scored.evidence_count, 5) * 0.05
        + case when scored.layer = 'current_state' then
          0.25 / (1.0 + greatest(extract(epoch from (now() - scored.updated_at)), 0)
            / 86400.0 / 30.0)
          else 0 end)::double precision as score
    from scored
    where scored.strong_match
    order by score desc, scored.updated_at desc, scored.id
    limit p_limit
  ), fallback as (
    select scored.*,
      ((scored.matched_terms::double precision / nullif(scored.total_terms, 0)) * 10.0
        + scored.partial_rank * 5.0 + scored.confidence
        + least(scored.evidence_count, 5) * 0.05
        + case when scored.layer = 'current_state' then
          0.25 / (1.0 + greatest(extract(epoch from (now() - scored.updated_at)), 0)
            / 86400.0 / 30.0)
          else 0 end)::double precision as score
    from scored
    where scored.matched_terms > 0 and not exists (select 1 from strong)
    order by scored.matched_terms desc, score desc, scored.updated_at desc, scored.id
    limit p_limit
  ), chosen as (
    select strong.id, strong.layer, strong.memory_type, strong.subject_key,
      strong.topic, strong.content, strong.context, strong.effective_status,
      strong.confidence, strong.provenance, strong.source_references,
      strong.evidence_count, strong.supersedes_memory_id,
      strong.superseded_by_memory_id, strong.valid_from, strong.valid_until,
      strong.stale_after, strong.last_confirmed_at, strong.created_at,
      strong.updated_at, strong.score
    from strong
    union all
    select fallback.id, fallback.layer, fallback.memory_type, fallback.subject_key,
      fallback.topic, fallback.content, fallback.context, fallback.effective_status,
      fallback.confidence, fallback.provenance, fallback.source_references,
      fallback.evidence_count, fallback.supersedes_memory_id,
      fallback.superseded_by_memory_id, fallback.valid_from, fallback.valid_until,
      fallback.stale_after, fallback.last_confirmed_at, fallback.created_at,
      fallback.updated_at, fallback.score
    from fallback
  )
  select chosen.id, chosen.layer, chosen.memory_type, chosen.subject_key,
    chosen.topic, chosen.content, chosen.context, chosen.effective_status,
    chosen.confidence, chosen.provenance, chosen.source_references,
    chosen.evidence_count, chosen.supersedes_memory_id,
    chosen.superseded_by_memory_id, chosen.valid_from, chosen.valid_until,
    chosen.stale_after, chosen.last_confirmed_at, chosen.created_at,
    chosen.updated_at, chosen.score
  from chosen
  order by chosen.score desc, chosen.updated_at desc, chosen.id
  limit p_limit;
end;
$function$;

-- A deterministic invalid candidate gets one actionable failed checkpoint.
-- Transient failures and stale claims remain eligible for the existing retry path.
create or replace function public.claim_next_memory_message(p_conversation_id text default null)
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
  where messages.role = 'user'
    and coalesce(processing.status, '') <> 'processed'
    and (
      processing.status is distinct from 'failed'
      or processing.last_error is null
      or processing.last_error not like '[nonretryable] %'
    )
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
