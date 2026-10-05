-- Bounded, owner-scoped full-text retrieval over completed conversation evidence.
-- The authenticated client JWT remains subject to RLS; there is no owner argument
-- and no service-role path.

alter table public.conversation_messages
  add column search_vector tsvector
  generated always as (to_tsvector('english', content)) stored;

create index conversation_messages_search_idx
  on public.conversation_messages using gin(search_vector);

create function public.search_completed_conversation_messages(
  p_search_query text,
  p_max_conversations integer default 4
) returns table (
  conversation_id text,
  completed_at timestamptz,
  relevance double precision,
  message_position integer,
  role text,
  content text,
  occurred_at timestamptz,
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
    raise exception 'Searching completed conversations requires an authenticated user.'
      using errcode = '42501';
  end if;

  if p_search_query is null or length(btrim(p_search_query)) < 1
    or length(p_search_query) > 1000
    or p_max_conversations < 1 or p_max_conversations > 4 then
    raise exception 'The completed conversation search request is invalid.';
  end if;

  return query
  with parsed_query as (
    select websearch_to_tsquery('english', p_search_query) as value
  ),
  ranked_messages as (
    select
      messages.conversation_id,
      conversations.completed_at,
      messages.position,
      ts_rank_cd(messages.search_vector, parsed_query.value)::double precision
        as relevance
    from public.conversation_messages messages
    join public.completed_conversations conversations
      on conversations.owner_id = messages.owner_id
      and conversations.id = messages.conversation_id
    cross join parsed_query
    where messages.owner_id = authenticated_owner
      and conversations.owner_id = authenticated_owner
      and conversations.status = 'completed'
      and messages.search_vector @@ parsed_query.value
  ),
  best_conversation_hits as (
    select distinct on (ranked_messages.conversation_id)
      ranked_messages.conversation_id,
      ranked_messages.completed_at,
      ranked_messages.position,
      ranked_messages.relevance
    from ranked_messages
    order by ranked_messages.conversation_id,
      ranked_messages.relevance desc,
      ranked_messages.position
  ),
  bounded_conversations as (
    select
      best_conversation_hits.*,
      count(*) over () > p_max_conversations as results_truncated
    from best_conversation_hits
    order by best_conversation_hits.relevance desc,
      best_conversation_hits.completed_at desc,
      best_conversation_hits.conversation_id
    limit p_max_conversations
  )
  select
    bounded_conversations.conversation_id,
    bounded_conversations.completed_at,
    bounded_conversations.relevance,
    nearby.position as message_position,
    nearby.role,
    left(nearby.content, 700) as content,
    nearby.occurred_at,
    length(nearby.content) > 700 as excerpt_truncated,
    bounded_conversations.results_truncated
  from bounded_conversations
  cross join lateral (
    select
      messages.position,
      messages.role,
      messages.content,
      messages.occurred_at
    from public.conversation_messages messages
    where messages.owner_id = authenticated_owner
      and messages.conversation_id = bounded_conversations.conversation_id
      and messages.position between greatest(bounded_conversations.position - 1, 0)
        and bounded_conversations.position + 1
    order by messages.position
    limit 3
  ) nearby
  order by bounded_conversations.relevance desc,
    bounded_conversations.completed_at desc,
    bounded_conversations.conversation_id,
    nearby.position;
end;
$function$;

revoke all on function public.search_completed_conversation_messages(text, integer)
  from public, anon;
grant execute on function public.search_completed_conversation_messages(text, integer)
  to authenticated;
