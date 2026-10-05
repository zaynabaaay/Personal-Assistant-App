-- Ambiguous memories remain non-authoritative, but their existing review
-- boundary now ages them to stale. Search keeps returning the same bounded
-- relevance score used by the assistant to distinguish useful rows from
-- generic partial-match distractors.
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
        when memories.status in ('current', 'ambiguous') and memories.valid_from is not null
          and memories.valid_from > now() then 'stale'
        when memories.status in ('current', 'ambiguous') and memories.valid_until is not null
          and memories.valid_until < now() then 'expired'
        when memories.status in ('current', 'ambiguous') and memories.stale_after is not null
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

-- Active ambiguous rows are open referents. Once their review boundary passes,
-- they remain preserved as stale evidence but rank behind active unresolved and
-- recent current rows unless the new message lexically names their subject.
create or replace function public.get_memory_analysis_context(
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
        when memories.status in ('current', 'ambiguous') and memories.valid_from is not null
          and memories.valid_from > now() then 'stale'
        when memories.status in ('current', 'ambiguous') and memories.valid_until is not null
          and memories.valid_until < now() then 'expired'
        when memories.status in ('current', 'ambiguous') and memories.stale_after is not null
          and memories.stale_after < now() then 'stale'
        else memories.status
      end as effective_status
    from public.general_memories memories
    where memories.owner_id = authenticated_owner and memories.status <> 'superseded'
  ), scored as (
    select effective.*,
      (effective.search_vector @@ query_value.value) as lexical_match,
      ts_rank_cd(effective.search_vector, query_value.value)::double precision as score,
      effective.effective_status = 'ambiguous' as active_open_referent,
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
    order by (effective.effective_status = 'ambiguous') desc,
      (effective.provenance = 'inferred'
        and effective.effective_status not in ('stale', 'expired')) desc,
      (effective.effective_status not in ('stale', 'expired')) desc,
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
  order by scored.lexical_match desc, scored.active_open_referent desc,
    (scored.unresolved and scored.effective_status not in ('stale', 'expired')) desc,
    (scored.effective_status not in ('stale', 'expired')) desc,
    scored.score desc, scored.updated_at desc, scored.id
  limit p_limit;
end;
$function$;

revoke all on function public.search_general_memories(text, text, boolean, integer)
  from public, anon;
revoke all on function public.get_memory_analysis_context(text, integer)
  from public, anon;
grant execute on function public.search_general_memories(text, text, boolean, integer)
  to authenticated;
grant execute on function public.get_memory_analysis_context(text, integer)
  to authenticated;
