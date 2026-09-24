-- Allow the authenticated client to persist a better deterministic title only
-- when the current stored title is visibly low quality. Transcript content,
-- structured memory, Project state, and completion timestamps are untouched.
create function public.update_completed_conversation_title(
  p_conversation_id text,
  p_expected_title text,
  p_title text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_owner uuid := auth.uid();
  stored_title text;
  current_is_poor boolean;
  replacement_is_poor boolean;
begin
  if authenticated_owner is null then
    raise exception 'Updating a chat title requires an authenticated user.' using errcode = '42501';
  end if;
  if p_conversation_id is null or length(btrim(p_conversation_id)) not between 1 and 300
    or p_expected_title is null or p_title is null
    or length(btrim(p_title)) not between 2 and 120 then
    raise exception 'The chat title update is invalid.';
  end if;

  select title into stored_title
  from public.completed_conversations
  where owner_id = authenticated_owner and id = p_conversation_id
  for update;
  if stored_title is null or stored_title is distinct from p_expected_title then return false; end if;

  current_is_poor := stored_title ~* '^(what|how|do|does|did|can|could|would|should|where|when|why|who|is|are|was|were)\y'
    or stored_title ~* '^(conversation|saved chat|chat|untitled)([[:space:]]*[—-]|$)'
    or stored_title ~ '[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}:[0-9]{2}'
    or stored_title ~* '\m(do|does|did|can|could|would|should)[[:space:]]+i\M'
    or stored_title ~* '\m(a|an|and|about|at|do|did|for|from|i|in|my|of|on|or|our|the|to|with)$'
    or position('?' in stored_title) > 0
    or cardinality(regexp_split_to_array(btrim(stored_title), '[[:space:]]+')) > 6;
  replacement_is_poor := p_title ~* '^(what|how|do|does|did|can|could|would|should|where|when|why|who|is|are|was|were)\y'
    or p_title ~* '^(conversation|saved chat|chat|untitled)([[:space:]]*[—-]|$)'
    or p_title ~ '[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}:[0-9]{2}'
    or p_title ~* '\m(a|an|and|about|at|do|did|for|from|i|in|my|of|on|or|our|the|to|with)$'
    or position('?' in p_title) > 0
    or cardinality(regexp_split_to_array(btrim(p_title), '[[:space:]]+')) > 5;
  if not current_is_poor or replacement_is_poor then return false; end if;

  update public.completed_conversations
  set title = btrim(p_title), metadata_status = 'fallback'
  where owner_id = authenticated_owner and id = p_conversation_id
    and title = p_expected_title;
  return found;
end;
$function$;

revoke all on function public.update_completed_conversation_title(text, text, text)
  from public, anon;
grant execute on function public.update_completed_conversation_title(text, text, text)
  to authenticated;
