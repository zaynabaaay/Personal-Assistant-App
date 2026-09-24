-- Project updated_at is the existing authoritative last-modified signal. Child
-- domain services call this narrow boundary after meaningful persisted work.
-- greatest() prevents delayed/retried activity from moving recency backwards.

create function public.touch_project_activity(
  p_project_id text,
  p_occurred_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_owner uuid := auth.uid();
begin
  if authenticated_owner is null then
    raise exception 'Project activity requires an authenticated user.' using errcode = '42501';
  end if;

  update public.projects
  set updated_at = greatest(updated_at, p_occurred_at)
  where owner_id = authenticated_owner and id = p_project_id;

  if not found then
    raise exception 'Project was not found.' using errcode = '42501';
  end if;
end;
$function$;

revoke all on function public.touch_project_activity(text, timestamptz) from public, anon;
grant execute on function public.touch_project_activity(text, timestamptz) to authenticated;
