-- Stage 1 compatibility shadow for future Project-global assets. The existing
-- project_resources.section_id relationship remains authoritative until a later
-- migration deliberately switches application reads and writes.

create table public.project_asset_section_placements (
  owner_id uuid not null default auth.uid(),
  project_id text not null,
  asset_id text not null,
  section_id text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, project_id, asset_id, section_id),
  unique (owner_id, project_id, asset_id),
  foreign key (owner_id, project_id, asset_id)
    references public.project_resources(owner_id, project_id, id) on delete cascade,
  foreign key (owner_id, project_id, section_id)
    references public.project_sections(owner_id, project_id, id)
);

create index project_asset_section_placements_section_idx
  on public.project_asset_section_placements(owner_id, project_id, section_id, asset_id);

alter table public.project_asset_section_placements enable row level security;

create policy project_asset_section_placements_owner_select
on public.project_asset_section_placements for select to authenticated
using (owner_id = (select auth.uid()));

revoke all on table public.project_asset_section_placements from public, anon, authenticated;
grant select on table public.project_asset_section_placements to authenticated;

create function private.validate_project_asset_section_placement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from public.project_resources resources
    where resources.owner_id = new.owner_id
      and resources.project_id = new.project_id
      and resources.id = new.asset_id
      and resources.resource_kind = 'uploaded_asset'
  ) then
    raise exception 'Project asset placements require an uploaded asset in the same owned Project.'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

create trigger project_asset_section_placements_validate
before insert or update on public.project_asset_section_placements
for each row execute function private.validate_project_asset_section_placement();

create function private.backfill_project_asset_section_placements()
returns void
language plpgsql
set search_path = ''
as $function$
begin
  if exists (
    select 1
    from public.project_resources resources
    where resources.resource_kind = 'uploaded_asset'
      and resources.section_id is null
  ) then
    raise exception 'Uploaded Project asset has no authoritative section relationship.';
  end if;

  insert into public.project_asset_section_placements (
    owner_id, project_id, asset_id, section_id, created_at
  )
  select
    resources.owner_id,
    resources.project_id,
    resources.id,
    resources.section_id,
    resources.created_at
  from public.project_resources resources
  where resources.resource_kind = 'uploaded_asset'
    and resources.section_id is not null
  on conflict do nothing;

  if exists (
    select 1
    from public.project_resources resources
    left join public.project_asset_section_placements placements
      on placements.owner_id = resources.owner_id
      and placements.project_id = resources.project_id
      and placements.asset_id = resources.id
    where resources.resource_kind = 'uploaded_asset'
    group by resources.owner_id, resources.project_id, resources.id, resources.section_id
    having count(placements.asset_id) <> 1
      or bool_or(placements.section_id is distinct from resources.section_id)
  ) then
    raise exception 'Uploaded Project asset placement backfill did not preserve the authoritative section relationship.';
  end if;

  if exists (
    select 1
    from public.project_asset_section_placements placements
    join public.project_resources resources
      on resources.owner_id = placements.owner_id
      and resources.project_id = placements.project_id
      and resources.id = placements.asset_id
    where resources.resource_kind <> 'uploaded_asset'
  ) then
    raise exception 'Legacy Project resources must not have asset placements.';
  end if;

  if exists (
    select 1
    from public.project_asset_section_placements placements
    join public.project_asset_upload_attempts attempts
      on attempts.owner_id = placements.owner_id
      and attempts.project_id = placements.project_id
      and attempts.asset_id = placements.asset_id
    where attempts.status = 'pending'
  ) then
    raise exception 'Pending Project asset uploads must not have placements.';
  end if;
end;
$function$;

select private.backfill_project_asset_section_placements();

create function private.sync_project_asset_section_placement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  placement_created_at timestamptz;
begin
  if new.resource_kind <> 'uploaded_asset' then return new; end if;
  if tg_op = 'UPDATE' and new.section_id is not distinct from old.section_id then return new; end if;
  if new.section_id is null then
    raise exception 'Uploaded Project assets require an authoritative section relationship.';
  end if;

  placement_created_at := case when tg_op = 'INSERT' then new.created_at else now() end;

  delete from public.project_asset_section_placements placements
  where placements.owner_id = new.owner_id
    and placements.project_id = new.project_id
    and placements.asset_id = new.id
    and placements.section_id <> new.section_id;

  insert into public.project_asset_section_placements (
    owner_id, project_id, asset_id, section_id, created_at
  ) values (
    new.owner_id, new.project_id, new.id, new.section_id, placement_created_at
  ) on conflict (owner_id, project_id, asset_id, section_id) do nothing;

  return new;
end;
$function$;

create trigger project_resources_sync_asset_section_placement
after insert or update on public.project_resources
for each row execute function private.sync_project_asset_section_placement();

revoke all on function private.validate_project_asset_section_placement() from public, anon, authenticated;
revoke all on function private.backfill_project_asset_section_placements() from public, anon, authenticated;
revoke all on function private.sync_project_asset_section_placement() from public, anon, authenticated;
