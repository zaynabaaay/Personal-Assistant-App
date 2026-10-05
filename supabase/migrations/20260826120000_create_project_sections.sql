-- Project sections are lightweight, user-facing containers. owner_id follows the
-- existing child-table convention and is bound to the authoritative Project owner
-- by the composite foreign key. It is not part of the TypeScript domain object.

create table public.project_sections (
  owner_id uuid not null default auth.uid(),
  id text not null,
  created_at timestamptz not null,
  is_default boolean not null default false,
  position integer not null check (position >= 0),
  project_id text not null,
  status text not null check (status in ('active', 'archived')),
  title text not null check (
    title = btrim(title) and char_length(title) between 1 and 48
  ),
  updated_at timestamptz not null,
  primary key (owner_id, id),
  unique (owner_id, project_id, id),
  foreign key (owner_id, project_id)
    references public.projects(owner_id, id) on delete cascade,
  check (
    not is_default or
    (title = 'Overview' and position = 0 and status = 'active')
  )
);

create unique index project_sections_one_default_idx
  on public.project_sections(owner_id, project_id)
  where is_default;

create unique index project_sections_active_title_idx
  on public.project_sections(owner_id, project_id, lower(title))
  where status = 'active';

create index project_sections_order_idx
  on public.project_sections(owner_id, project_id, status, position, id);

create function private.protect_project_section_identity()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.owner_id is distinct from old.owner_id
    or new.project_id is distinct from old.project_id
    or new.is_default is distinct from old.is_default then
    raise exception 'Project section ownership and default identity are immutable.'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

create trigger project_sections_protect_identity
before update on public.project_sections
for each row execute function private.protect_project_section_identity();

alter table public.project_sections enable row level security;

create policy project_sections_owner_access
on public.project_sections for all to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

revoke all on table public.project_sections from public, anon;
grant select, insert, update on table public.project_sections to authenticated;

-- Existing Projects receive one deterministic Overview. The stable ID and unique
-- partial index make initialization retry-safe without touching other Project data.
insert into public.project_sections (
  owner_id, id, created_at, is_default, position, project_id, status, title, updated_at
)
select
  owner_id,
  'project-section-overview:' || id,
  created_at,
  true,
  0,
  id,
  'active',
  'Overview',
  updated_at
from public.projects
on conflict (owner_id, id) do nothing;

create or replace function public.commit_project_changes(p_changes jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_owner uuid := auth.uid();
begin
  if authenticated_owner is null then
    raise exception 'Project writes require an authenticated user.' using errcode = '42501';
  end if;

  perform private.upsert_owned_project_rows('public.projects', coalesce(p_changes->'projects', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_sections', coalesce(p_changes->'sections', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_milestones', coalesce(p_changes->'milestones', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_deliverables', coalesce(p_changes->'deliverables', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_work_sessions', coalesce(p_changes->'work_sessions', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_tasks', coalesce(p_changes->'tasks', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_knowledge_items', coalesce(p_changes->'knowledge_items', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_decisions', coalesce(p_changes->'decisions', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_resources', coalesce(p_changes->'resources', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_work_session_entries', coalesce(p_changes->'work_session_entries', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_change_events', coalesce(p_changes->'change_events', '[]'::jsonb), authenticated_owner);
end;
$function$;

revoke all on function public.commit_project_changes(jsonb) from public, anon;
grant execute on function public.commit_project_changes(jsonb) to authenticated;

create function public.reorder_project_sections(
  p_project_id text,
  p_section_ids text[],
  p_updated_at timestamptz
) returns setof public.project_sections
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_owner uuid := auth.uid();
  active_count integer;
  distinct_count integer;
begin
  if authenticated_owner is null then
    raise exception 'Project writes require an authenticated user.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.projects
    where owner_id = authenticated_owner and id = p_project_id
  ) then
    raise exception 'Project was not found.' using errcode = '42501';
  end if;
  if p_section_ids is null or cardinality(p_section_ids) = 0 or p_updated_at is null then
    raise exception 'A complete section order and update time are required.';
  end if;

  select count(*) into active_count
  from public.project_sections
  where owner_id = authenticated_owner
    and project_id = p_project_id
    and status = 'active';

  select count(distinct section_id) into distinct_count
  from unnest(p_section_ids) section_id;

  if cardinality(p_section_ids) <> active_count
    or distinct_count <> active_count
    or exists (
      select 1 from unnest(p_section_ids) section_id
      where not exists (
        select 1 from public.project_sections sections
        where sections.owner_id = authenticated_owner
          and sections.project_id = p_project_id
          and sections.id = section_id
          and sections.status = 'active'
      )
    ) then
    raise exception 'Section order must contain every active section in this Project exactly once.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.project_sections
    where owner_id = authenticated_owner
      and project_id = p_project_id
      and id = p_section_ids[1]
      and is_default
  ) then
    raise exception 'Overview must remain first.';
  end if;

  update public.project_sections sections
  set position = ordered.ordinality - 1,
      updated_at = p_updated_at
  from unnest(p_section_ids) with ordinality ordered(section_id, ordinality)
  where sections.owner_id = authenticated_owner
    and sections.project_id = p_project_id
    and sections.id = ordered.section_id
    and sections.status = 'active';

  return query
  select sections.*
  from public.project_sections sections
  where sections.owner_id = authenticated_owner
    and sections.project_id = p_project_id
    and sections.status = 'active'
  order by sections.position, sections.id;
end;
$function$;

revoke all on function public.reorder_project_sections(text, text[], timestamptz)
  from public, anon;
grant execute on function public.reorder_project_sections(text, text[], timestamptz)
  to authenticated;
