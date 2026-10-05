-- Second-stage, bounded evidence retrieval inside owner-scoped completed
-- conversations selected by the existing conversation search.

create function public.search_completed_conversation_evidence(
  p_conversation_ids text[],
  p_search_query text,
  p_preferred_role text default 'both',
  p_prefer_recent boolean default false,
  p_max_messages integer default 16
) returns table (
  conversation_id text,
  completed_at timestamptz,
  relevance double precision,
  message_position integer,
  role text,
  content text,
  occurred_at timestamptz,
  direct_match boolean,
  role_match boolean,
  excerpt_truncated boolean,
  results_truncated boolean
)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  authenticated_owner uuid := auth.uid();
begin
  if authenticated_owner is null then
    raise exception 'Searching completed conversation evidence requires an authenticated user.'
      using errcode = '42501';
  end if;

  if p_conversation_ids is null
    or cardinality(p_conversation_ids) < 1
    or cardinality(p_conversation_ids) > 4
    or exists (
      select 1 from unnest(p_conversation_ids) requested_id(value)
      where requested_id.value is null or length(btrim(requested_id.value)) < 1
        or length(requested_id.value) > 200
    )
    or p_search_query is null
    or length(btrim(p_search_query)) < 1
    or length(p_search_query) > 1000
    or p_preferred_role not in ('user', 'assistant', 'both')
    or p_max_messages < 1
    or p_max_messages > 16 then
    raise exception 'The completed conversation evidence request is invalid.';
  end if;

  return query
  with parsed_query as (
    select websearch_to_tsquery('english', p_search_query) as value
  ),
  selected_conversations as (
    select distinct on (requested.conversation_id)
      conversations.id as conversation_id,
      conversations.completed_at,
      requested.conversation_rank
    from unnest(p_conversation_ids) with ordinality
      requested(conversation_id, conversation_rank)
    join public.completed_conversations conversations
      on conversations.owner_id = authenticated_owner
      and conversations.id = requested.conversation_id
      and conversations.status = 'completed'
    order by requested.conversation_id, requested.conversation_rank
  ),
  scored_messages as (
    select
      messages.conversation_id,
      selected_conversations.completed_at,
      selected_conversations.conversation_rank,
      messages.position,
      messages.role,
      messages.content,
      messages.occurred_at,
      messages.search_vector @@ parsed_query.value as direct_match,
      p_preferred_role = 'both' or messages.role = p_preferred_role as role_match,
      ts_rank_cd(messages.search_vector, parsed_query.value)::double precision
        as relevance,
      coalesce((
        select min(abs(anchor.position - messages.position))
        from public.conversation_messages anchor
        where anchor.owner_id = authenticated_owner
          and anchor.conversation_id = messages.conversation_id
          and anchor.search_vector @@ parsed_query.value
      ), 100000) as anchor_distance
    from selected_conversations
    join public.conversation_messages messages
      on messages.owner_id = authenticated_owner
      and messages.conversation_id = selected_conversations.conversation_id
    cross join parsed_query
  ),
  weighted_messages as (
    select
      scored_messages.*,
      (
        case when scored_messages.direct_match then 2.0 else 0.0 end
        + scored_messages.relevance * 4.0
        + 0.2 / scored_messages.conversation_rank::double precision
        + case when p_prefer_recent then
          0.75 / (
            1.0 + greatest(extract(epoch from (
              max(scored_messages.completed_at) over () - scored_messages.completed_at
            )) / 86400.0, 0.0) / 30.0
          )
        else 0.0 end
        - least(scored_messages.anchor_distance, 50) * 0.003
      ) as evidence_score
    from scored_messages
  ),
  ranked_per_conversation as (
    select
      weighted_messages.*,
      row_number() over (
        partition by weighted_messages.conversation_id
        order by
          weighted_messages.role_match desc,
          weighted_messages.evidence_score desc,
          weighted_messages.position desc
      ) as conversation_evidence_rank
    from weighted_messages
  ),
  globally_ranked as (
    select
      ranked_per_conversation.*,
      (select count(*) from scored_messages) > p_max_messages as results_truncated
    from ranked_per_conversation
    where ranked_per_conversation.conversation_evidence_rank <= p_max_messages
    order by
      case when ranked_per_conversation.conversation_evidence_rank <= 2 then 0 else 1 end,
      ranked_per_conversation.role_match desc,
      ranked_per_conversation.evidence_score desc,
      ranked_per_conversation.completed_at desc,
      ranked_per_conversation.position desc
    limit p_max_messages
  )
  select
    globally_ranked.conversation_id,
    globally_ranked.completed_at,
    globally_ranked.relevance,
    globally_ranked.position as message_position,
    globally_ranked.role,
    left(globally_ranked.content, 600) as content,
    globally_ranked.occurred_at,
    globally_ranked.direct_match,
    globally_ranked.role_match,
    length(globally_ranked.content) > 600 as excerpt_truncated,
    globally_ranked.results_truncated
  from globally_ranked
  order by
    case when globally_ranked.conversation_evidence_rank <= 2 then 0 else 1 end,
    globally_ranked.role_match desc,
    globally_ranked.evidence_score desc,
    globally_ranked.completed_at desc,
    globally_ranked.conversation_id,
    globally_ranked.position;
end;
$function$;

revoke all on function public.search_completed_conversation_evidence(
  text[], text, text, boolean, integer
) from public, anon;
grant execute on function public.search_completed_conversation_evidence(
  text[], text, text, boolean, integer
) to authenticated;
