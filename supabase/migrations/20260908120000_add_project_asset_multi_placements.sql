-- Stage 2B: assets remain singular while section membership becomes many-to-many.
-- project_resources.section_id continues to designate one compatibility placement.

do $block$
declare temporary_uniqueness record;
begin
  for temporary_uniqueness in
    select constraints.conname
    from pg_catalog.pg_constraint constraints
    where constraints.conrelid = 'public.project_asset_section_placements'::pg_catalog.regclass
      and constraints.contype = 'u'
      and pg_catalog.pg_get_constraintdef(constraints.oid) = 'UNIQUE (owner_id, project_id, asset_id)'
  loop
    execute pg_catalog.format('alter table public.project_asset_section_placements drop constraint %I',
      temporary_uniqueness.conname);
  end loop;
end;
$block$;

-- Existing-asset mutations always lock the Project resource first, then every
-- relevant section in ascending ID order. New upload finalization has no
-- resource row to lock yet, so its resource validation locks the destination
-- section before the resource is inserted. Section archival uses the row lock
-- taken by its UPDATE and therefore serializes with these locks.
create or replace function private.lock_project_asset_sections(
  p_owner_id uuid, p_project_id text, p_section_ids text[]
) returns void language plpgsql security definer set search_path = '' as $function$
begin
  perform 1
  from public.project_sections sections
  where sections.owner_id = p_owner_id and sections.project_id = p_project_id
    and sections.id = any(p_section_ids)
  order by sections.id
  for update;
end;
$function$;

create or replace function private.validate_project_asset_section_placement()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform 1 from public.project_resources resources
    where resources.owner_id = new.owner_id and resources.project_id = new.project_id
      and resources.id = new.asset_id and resources.resource_kind = 'uploaded_asset'
    for update;
  if not found then
    raise exception 'Project asset placements require an uploaded asset in the same owned Project.'
      using errcode = '42501';
  end if;
  perform private.lock_project_asset_sections(
    new.owner_id, new.project_id, array[new.section_id]
  );
  if not exists (
    select 1 from public.project_sections sections
    where sections.owner_id = new.owner_id and sections.project_id = new.project_id
      and sections.id = new.section_id and sections.status = 'active'
  ) then
    raise exception 'New Project asset placements require an active section in the same owned Project.'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

create or replace function private.validate_project_asset_relationships()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare expected_object text;
begin
  if new.resource_kind = 'legacy' then return new; end if;
  expected_object := pg_catalog.split_part(new.storage_path, '/', 4);
  if not private.project_asset_path_matches(
    new.storage_path, new.owner_id, new.project_id, new.id, expected_object
  ) then
    raise exception 'Project asset path must contain exactly owner/Project/asset/object.'
      using errcode = '42501';
  end if;
  if tg_op = 'INSERT' or new.section_id is distinct from old.section_id then
    perform private.lock_project_asset_sections(
      new.owner_id, new.project_id, array[new.section_id]
    );
    if not exists (
      select 1 from public.project_sections sections
      where sections.owner_id = new.owner_id and sections.project_id = new.project_id
        and sections.id = new.section_id and sections.status = 'active'
    ) then
      raise exception 'Project assets require an active section in the same owned Project.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;

create or replace function private.backfill_project_asset_section_placements()
returns void language plpgsql set search_path = '' as $function$
begin
  if exists (
    select 1 from public.project_resources resources
    where resources.resource_kind = 'uploaded_asset' and resources.section_id is null
  ) then
    raise exception 'Uploaded Project asset has no authoritative section relationship.';
  end if;
  insert into public.project_asset_section_placements(
    owner_id, project_id, asset_id, section_id, created_at
  )
  select resources.owner_id, resources.project_id, resources.id,
    resources.section_id, resources.created_at
  from public.project_resources resources
  where resources.resource_kind = 'uploaded_asset' and resources.section_id is not null
    and not exists (
      select 1 from public.project_asset_section_placements placements
      where placements.owner_id = resources.owner_id
        and placements.project_id = resources.project_id
        and placements.asset_id = resources.id
        and placements.section_id = resources.section_id
    );
  if exists (
    select 1 from public.project_resources resources
    left join public.project_asset_section_placements placements
      on placements.owner_id = resources.owner_id and placements.project_id = resources.project_id
      and placements.asset_id = resources.id
    where resources.resource_kind = 'uploaded_asset'
    group by resources.owner_id, resources.project_id, resources.id, resources.section_id
    having count(placements.asset_id) < 1
      or not bool_or(placements.section_id = resources.section_id)
  ) then
    raise exception 'Uploaded Project asset placements do not contain the authoritative section relationship.';
  end if;
end;
$function$;

create or replace function private.touch_project_asset_placement_activity(
  p_owner_id uuid, p_project_id text
) returns void language plpgsql security definer set search_path = '' as $function$
begin
  begin
    update public.projects
    set updated_at = greatest(updated_at, pg_catalog.clock_timestamp())
    where owner_id = p_owner_id and id = p_project_id;
  exception when others then
    -- Placement membership is authoritative; recency is secondary metadata.
    null;
  end;
end;
$function$;

create or replace function private.sync_project_asset_section_placement()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if new.resource_kind <> 'uploaded_asset' then return new; end if;
  if new.section_id is null then
    raise exception 'Uploaded Project assets require an authoritative section relationship.';
  end if;

  if tg_op = 'UPDATE' and new.section_id is distinct from old.section_id then
    delete from public.project_asset_section_placements placements
    where placements.owner_id = new.owner_id and placements.project_id = new.project_id
      and placements.asset_id = new.id and placements.section_id = old.section_id;
  end if;

  if not exists (
    select 1 from public.project_asset_section_placements placements
    where placements.owner_id = new.owner_id and placements.project_id = new.project_id
      and placements.asset_id = new.id and placements.section_id = new.section_id
  ) then
    insert into public.project_asset_section_placements(
      owner_id, project_id, asset_id, section_id, created_at
    ) values (
      new.owner_id, new.project_id, new.id, new.section_id,
      case when tg_op = 'INSERT' then new.created_at else pg_catalog.clock_timestamp() end
    );
  end if;

  if tg_op = 'UPDATE' and new.section_id is distinct from old.section_id then
    perform private.touch_project_asset_placement_activity(new.owner_id, new.project_id);
  end if;
  return new;
end;
$function$;

create or replace function public.add_project_asset_to_section(
  p_project_id text, p_asset_id text, p_section_id text
) returns public.project_resources language plpgsql security definer set search_path = '' as $function$
declare
  authenticated_owner uuid := auth.uid();
  asset public.project_resources%rowtype;
  inserted_count integer;
begin
  if authenticated_owner is null then
    raise exception 'Adding Project material requires authentication.' using errcode = '42501';
  end if;
  select * into asset from public.project_resources resources
  where resources.owner_id = authenticated_owner and resources.project_id = p_project_id
    and resources.id = p_asset_id and resources.resource_kind = 'uploaded_asset' for update;
  if not found then
    raise exception 'Project asset was not found in this Project.' using errcode = '42501';
  end if;
  perform private.lock_project_asset_sections(
    authenticated_owner, p_project_id, array[p_section_id]
  );
  if not exists (
    select 1 from public.project_sections sections
    where sections.owner_id = authenticated_owner and sections.project_id = p_project_id
      and sections.id = p_section_id and sections.status = 'active'
  ) then
    raise exception 'The selected section is not active in this Project.' using errcode = '42501';
  end if;
  insert into public.project_asset_section_placements(owner_id, project_id, asset_id, section_id)
  values (authenticated_owner, p_project_id, p_asset_id, p_section_id)
  on conflict (owner_id, project_id, asset_id, section_id) do nothing;
  get diagnostics inserted_count = row_count;
  if inserted_count = 1 then
    perform private.touch_project_asset_placement_activity(authenticated_owner, p_project_id);
  end if;
  return asset;
end;
$function$;

create or replace function public.remove_project_asset_from_section(
  p_project_id text, p_asset_id text, p_section_id text
) returns public.project_resources language plpgsql security definer set search_path = '' as $function$
declare
  authenticated_owner uuid := auth.uid();
  asset public.project_resources%rowtype;
  fallback_section_id text;
  placement_count integer;
begin
  if authenticated_owner is null then
    raise exception 'Removing Project material requires authentication.' using errcode = '42501';
  end if;
  select * into asset from public.project_resources resources
  where resources.owner_id = authenticated_owner and resources.project_id = p_project_id
    and resources.id = p_asset_id and resources.resource_kind = 'uploaded_asset' for update;
  if not found then
    raise exception 'Project asset was not found in this Project.' using errcode = '42501';
  end if;
  perform private.lock_project_asset_sections(
    authenticated_owner, p_project_id,
    array(
      select placements.section_id
      from public.project_asset_section_placements placements
      where placements.owner_id = authenticated_owner and placements.project_id = p_project_id
        and placements.asset_id = p_asset_id
      order by placements.section_id
    )
  );
  if not exists (
    select 1 from public.project_asset_section_placements placements
    where placements.owner_id = authenticated_owner and placements.project_id = p_project_id
      and placements.asset_id = p_asset_id and placements.section_id = p_section_id
  ) then return asset; end if;
  select count(*) into placement_count from public.project_asset_section_placements placements
  where placements.owner_id = authenticated_owner and placements.project_id = p_project_id
    and placements.asset_id = p_asset_id;
  if placement_count <= 1 then
    raise exception 'This material must remain in at least one section for now.' using errcode = '23514';
  end if;

  if asset.section_id = p_section_id then
    select placements.section_id into fallback_section_id
    from public.project_asset_section_placements placements
    join public.project_sections sections
      on sections.owner_id = placements.owner_id and sections.project_id = placements.project_id
      and sections.id = placements.section_id and sections.status = 'active'
    where placements.owner_id = authenticated_owner and placements.project_id = p_project_id
      and placements.asset_id = p_asset_id and placements.section_id <> p_section_id
    order by placements.created_at, placements.section_id limit 1;
    if fallback_section_id is null then
      raise exception 'This material must remain in at least one active section for now.'
        using errcode = '23514';
    end if;
    update public.project_resources
    set section_id = fallback_section_id, updated_at = pg_catalog.clock_timestamp()
    where owner_id = authenticated_owner and project_id = p_project_id and id = p_asset_id
    returning * into asset;
  else
    delete from public.project_asset_section_placements placements
    where placements.owner_id = authenticated_owner and placements.project_id = p_project_id
      and placements.asset_id = p_asset_id and placements.section_id = p_section_id;
    perform private.touch_project_asset_placement_activity(authenticated_owner, p_project_id);
  end if;
  return asset;
end;
$function$;

create or replace function public.replace_project_asset_section(
  p_project_id text, p_asset_id text, p_source_section_id text, p_target_section_id text
) returns public.project_resources language plpgsql security definer set search_path = '' as $function$
declare
  authenticated_owner uuid := auth.uid();
  asset public.project_resources%rowtype;
begin
  if authenticated_owner is null then
    raise exception 'Moving Project material requires authentication.' using errcode = '42501';
  end if;
  select * into asset from public.project_resources resources
  where resources.owner_id = authenticated_owner and resources.project_id = p_project_id
    and resources.id = p_asset_id and resources.resource_kind = 'uploaded_asset' for update;
  if not found then
    raise exception 'Project asset was not found in this Project.' using errcode = '42501';
  end if;
  perform private.lock_project_asset_sections(
    authenticated_owner, p_project_id,
    array(
      select section_id from unnest(array[p_source_section_id, p_target_section_id]) section_id
      order by section_id
    )
  );
  if not exists (
    select 1 from public.project_asset_section_placements placements
    where placements.owner_id = authenticated_owner and placements.project_id = p_project_id
      and placements.asset_id = p_asset_id and placements.section_id = p_source_section_id
  ) then
    raise exception 'The source section does not contain this material.' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.project_sections sections
    where sections.owner_id = authenticated_owner and sections.project_id = p_project_id
      and sections.id = p_target_section_id and sections.status = 'active'
  ) then
    raise exception 'The selected section is not active in this Project.' using errcode = '42501';
  end if;
  if p_source_section_id = p_target_section_id then return asset; end if;

  if asset.section_id = p_source_section_id then
    update public.project_resources
    set section_id = p_target_section_id, updated_at = pg_catalog.clock_timestamp()
    where owner_id = authenticated_owner and project_id = p_project_id and id = p_asset_id
    returning * into asset;
  else
    insert into public.project_asset_section_placements(owner_id, project_id, asset_id, section_id)
    values (authenticated_owner, p_project_id, p_asset_id, p_target_section_id)
    on conflict (owner_id, project_id, asset_id, section_id) do nothing;
    delete from public.project_asset_section_placements placements
    where placements.owner_id = authenticated_owner and placements.project_id = p_project_id
      and placements.asset_id = p_asset_id and placements.section_id = p_source_section_id;
    perform private.touch_project_asset_placement_activity(authenticated_owner, p_project_id);
  end if;
  return asset;
end;
$function$;

revoke all on function private.lock_project_asset_sections(uuid, text, text[]) from public, anon, authenticated;
revoke all on function private.validate_project_asset_relationships() from public, anon, authenticated;
revoke all on function private.touch_project_asset_placement_activity(uuid, text) from public, anon, authenticated;
revoke all on function public.add_project_asset_to_section(text, text, text) from public, anon;
revoke all on function public.remove_project_asset_from_section(text, text, text) from public, anon;
revoke all on function public.replace_project_asset_section(text, text, text, text) from public, anon;
grant execute on function public.add_project_asset_to_section(text, text, text) to authenticated;
grant execute on function public.remove_project_asset_from_section(text, text, text) to authenticated;
grant execute on function public.replace_project_asset_section(text, text, text, text) to authenticated;
