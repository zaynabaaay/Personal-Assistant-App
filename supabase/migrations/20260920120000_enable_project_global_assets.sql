-- Stage 2C: the Project owns an uploaded asset and section placements are
-- optional, authoritative memberships. project_resources.section_id remains a
-- nullable mixed-version compatibility designation while older clients exist.

alter table public.project_resources
  drop constraint project_resources_uploaded_shape_check;

alter table public.project_resources
  add constraint project_resources_uploaded_shape_check check (
    (
      resource_kind = 'legacy' and storage_path is null and byte_size is null and
      original_filename is null and section_id is null and width is null and height is null
    ) or (
      resource_kind = 'uploaded_asset' and storage_path is not null and byte_size is not null and
      mime_type is not null and original_filename is not null and
      btrim(original_filename) = original_filename and
      char_length(original_filename) between 1 and 512 and
      external_url is null and role = 'reference' and
      source_metadata->>'kind' = 'original-upload' and
      source_metadata->>'picker' in ('document-picker', 'photo-library', 'web-file-picker') and
      (
        (type = 'image' and mime_type like 'image/%' and width is not null and height is not null) or
        (type <> 'image' and width is null and height is null)
      )
    )
  );

alter table public.project_asset_upload_attempts
  alter column section_id drop not null;

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
    if new.section_id is null then
      if exists (
        select 1 from public.project_asset_section_placements placements
        where placements.owner_id = new.owner_id and placements.project_id = new.project_id
          and placements.asset_id = new.id
      ) then
        raise exception 'A placed Project asset requires a compatibility section designation.'
          using errcode = '23514';
      end if;
    else
      perform private.lock_project_asset_sections(
        new.owner_id, new.project_id, array[new.section_id]
      );
      -- A controlled designated-removal may select an existing placement in an
      -- archived section. Creating a new relationship still requires active.
      if not exists (
        select 1 from public.project_asset_section_placements placements
        where placements.owner_id = new.owner_id and placements.project_id = new.project_id
          and placements.asset_id = new.id and placements.section_id = new.section_id
      ) and not exists (
        select 1 from public.project_sections sections
        where sections.owner_id = new.owner_id and sections.project_id = new.project_id
          and sections.id = new.section_id and sections.status = 'active'
      ) then
        raise exception 'Project assets require an active section in the same owned Project.'
          using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$function$;

create or replace function private.sync_project_asset_section_placement()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if old.resource_kind = 'uploaded_asset' and new.section_id is distinct from old.section_id
    and pg_catalog.pg_trigger_depth() = 1 then
    raise exception 'Project asset compatibility sections are maintained by placement operations.'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

drop trigger project_resources_sync_asset_section_placement on public.project_resources;
create trigger project_resources_sync_asset_section_placement
before update on public.project_resources
for each row execute function private.sync_project_asset_section_placement();

create function private.sync_project_asset_compatibility_from_placement()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  compatibility_section_id text;
  fallback_section_id text;
  placement_owner_id uuid := case when tg_op = 'DELETE' then old.owner_id else new.owner_id end;
  placement_project_id text := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
  placement_asset_id text := case when tg_op = 'DELETE' then old.asset_id else new.asset_id end;
begin
  select resources.section_id into compatibility_section_id
  from public.project_resources resources
  where resources.owner_id = placement_owner_id
    and resources.project_id = placement_project_id and resources.id = placement_asset_id
  for update;
  if not found then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'INSERT' and compatibility_section_id is null then
    update public.project_resources
    set section_id = new.section_id, updated_at = pg_catalog.clock_timestamp()
    where owner_id = placement_owner_id and project_id = placement_project_id
      and id = placement_asset_id;
  elsif tg_op = 'UPDATE' and new.section_id is distinct from old.section_id
    and compatibility_section_id = old.section_id then
    update public.project_resources
    set section_id = new.section_id, updated_at = pg_catalog.clock_timestamp()
    where owner_id = placement_owner_id and project_id = placement_project_id
      and id = placement_asset_id;
  elsif tg_op = 'DELETE' and compatibility_section_id = old.section_id then
    select placements.section_id into fallback_section_id
    from public.project_asset_section_placements placements
    join public.project_sections sections
      on sections.owner_id = placements.owner_id and sections.project_id = placements.project_id
      and sections.id = placements.section_id
    where placements.owner_id = placement_owner_id and placements.project_id = placement_project_id
      and placements.asset_id = placement_asset_id
    order by (sections.status = 'active') desc, placements.created_at, placements.section_id
    limit 1;
    update public.project_resources
    set section_id = fallback_section_id, updated_at = pg_catalog.clock_timestamp()
    where owner_id = placement_owner_id and project_id = placement_project_id
      and id = placement_asset_id;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

create trigger project_asset_section_placements_sync_compatibility
after insert or update or delete on public.project_asset_section_placements
for each row execute function private.sync_project_asset_compatibility_from_placement();

-- Retain the historical private entry point as a read-only invariant check.
create or replace function private.backfill_project_asset_section_placements()
returns void language plpgsql set search_path = '' as $function$
begin
  if exists (
    select 1
    from public.project_resources resources
    left join public.project_asset_section_placements placements
      on placements.owner_id = resources.owner_id and placements.project_id = resources.project_id
      and placements.asset_id = resources.id
    where resources.resource_kind = 'uploaded_asset'
    group by resources.owner_id, resources.project_id, resources.id, resources.section_id
    having (count(placements.asset_id) = 0 and resources.section_id is not null)
      or (count(placements.asset_id) > 0 and resources.section_id is null)
      or (resources.section_id is not null and
        not bool_or(placements.section_id = resources.section_id))
  ) then
    raise exception 'Project asset compatibility designation does not match its placements.';
  end if;
end;
$function$;

create or replace function public.begin_project_asset_upload(
  p_attempt_id text, p_asset_id text, p_object_id text, p_project_id text,
  p_section_id text, p_original_filename text, p_mime_type text, p_byte_size bigint,
  p_source_picker text, p_width integer default null, p_height integer default null
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  authenticated_owner uuid := auth.uid();
  existing public.project_asset_upload_attempts%rowtype;
  expected_path text;
begin
  if authenticated_owner is null then
    raise exception 'Project asset uploads require authentication.' using errcode = '42501';
  end if;
  if p_attempt_id !~ '^[^/]+$' or p_asset_id !~ '^[^/]+$'
    or p_object_id !~ '^[^/]+$' or p_project_id !~ '^[^/]+$' then
    raise exception 'Upload identity components must be non-empty and slash-free.' using errcode = '42501';
  end if;
  if p_byte_size is null or p_byte_size not between 1 and 26214400 then
    raise exception 'Project asset size is invalid.';
  end if;
  if p_original_filename is null or p_original_filename <> btrim(p_original_filename)
    or char_length(p_original_filename) not between 1 and 512 then
    raise exception 'Project asset filename is invalid.';
  end if;
  if p_source_picker not in ('document-picker', 'photo-library', 'web-file-picker') then
    raise exception 'Project asset picker source is invalid.';
  end if;
  if p_mime_type not in (
    'application/msword', 'application/pdf', 'application/rtf',
    'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/gif', 'image/heic', 'image/heif', 'image/jpeg', 'image/png', 'image/webp',
    'text/plain'
  ) then raise exception 'Project asset declared MIME type is not supported.'; end if;
  if p_mime_type like 'image/%' then
    if p_width is null or p_height is null or p_width <= 0 or p_height <= 0
      or p_width > 8192 or p_height > 8192
      or p_width::bigint * p_height::bigint > 32000000 then
      raise exception 'Project image dimensions exceed the safe preview limit.';
    end if;
  elsif p_width is not null or p_height is not null then
    raise exception 'Only image assets may include dimensions.';
  end if;

  if not exists (
    select 1 from public.projects projects
    where projects.owner_id = authenticated_owner and projects.id = p_project_id
  ) then
    raise exception 'Project was not found.' using errcode = '42501';
  end if;
  if p_section_id is not null then
    perform private.lock_project_asset_sections(
      authenticated_owner, p_project_id, array[p_section_id]
    );
    if not exists (
      select 1 from public.project_sections sections
      where sections.owner_id = authenticated_owner and sections.project_id = p_project_id
        and sections.id = p_section_id and sections.status = 'active'
    ) then
      raise exception 'Project assets require an active section in the same owned Project.'
        using errcode = '42501';
    end if;
  end if;

  expected_path := authenticated_owner::text || '/' || p_project_id || '/' || p_asset_id || '/' || p_object_id;
  select * into existing from public.project_asset_upload_attempts attempts
    where attempts.owner_id = authenticated_owner and attempts.attempt_id = p_attempt_id for update;
  if found then
    if existing.asset_id is distinct from p_asset_id or existing.object_id is distinct from p_object_id
      or existing.project_id is distinct from p_project_id or existing.section_id is distinct from p_section_id
      or existing.original_filename is distinct from p_original_filename
      or existing.mime_type is distinct from p_mime_type or existing.byte_size is distinct from p_byte_size
      or existing.source_picker is distinct from p_source_picker or existing.width is distinct from p_width
      or existing.height is distinct from p_height or existing.storage_path is distinct from expected_path then
      raise exception 'Upload attempt identity and original metadata are immutable.' using errcode = '42501';
    end if;
    if existing.status = 'cleaned' then
      if private.project_asset_storage_object_exists(existing.storage_path) then
        raise exception 'A cleaned upload attempt still has a Storage object.';
      end if;
      update public.project_asset_upload_attempts set status = 'pending', updated_at = now()
        where owner_id = authenticated_owner and attempt_id = p_attempt_id returning * into existing;
    end if;
  else
    insert into public.project_asset_upload_attempts (
      owner_id, attempt_id, asset_id, byte_size, height, mime_type, object_id,
      original_filename, project_id, section_id, source_picker, storage_path, width
    ) values (
      authenticated_owner, p_attempt_id, p_asset_id, p_byte_size, p_height, p_mime_type,
      p_object_id, p_original_filename, p_project_id, p_section_id, p_source_picker,
      expected_path, p_width
    ) returning * into existing;
  end if;
  return pg_catalog.jsonb_build_object(
    'attempt_id', existing.attempt_id, 'asset_id', existing.asset_id,
    'object_id', existing.object_id, 'project_id', existing.project_id,
    'section_id', existing.section_id, 'storage_path', existing.storage_path,
    'status', existing.status,
    'object_exists', private.project_asset_storage_object_exists(existing.storage_path)
  );
end;
$function$;

create or replace function public.finalize_project_asset_upload(p_attempt_id text)
returns public.project_resources language plpgsql security definer set search_path = '' as $function$
declare
  authenticated_owner uuid := auth.uid();
  attempt public.project_asset_upload_attempts%rowtype;
  asset public.project_resources%rowtype;
  resource_type text;
begin
  if authenticated_owner is null then
    raise exception 'Project asset uploads require authentication.' using errcode = '42501';
  end if;
  select * into attempt from public.project_asset_upload_attempts attempts
    where attempts.owner_id = authenticated_owner and attempts.attempt_id = p_attempt_id for update;
  if not found then raise exception 'Project asset upload attempt was not found.' using errcode = '42501'; end if;
  if attempt.status = 'finalized' then
    if not private.project_asset_storage_object_exists(attempt.storage_path) then
      raise exception 'Finalized upload metadata has no exact Storage object.';
    end if;
    select * into asset from public.project_resources resources
    where resources.owner_id = authenticated_owner and resources.id = attempt.asset_id
      and resources.resource_kind = 'uploaded_asset' and resources.storage_path = attempt.storage_path;
    if not found then raise exception 'Finalized upload metadata is inconsistent.'; end if;
    return asset;
  end if;
  if attempt.status <> 'pending' then raise exception 'Project asset upload attempt is not pending.'; end if;
  if not private.project_asset_storage_object_exists(attempt.storage_path) then
    raise exception 'The exact reserved Storage object does not exist.';
  end if;
  if not private.project_asset_path_matches(
    attempt.storage_path, authenticated_owner, attempt.project_id, attempt.asset_id, attempt.object_id
  ) then raise exception 'Reserved Project asset path is invalid.' using errcode = '42501'; end if;
  if attempt.section_id is not null then
    perform private.lock_project_asset_sections(
      authenticated_owner, attempt.project_id, array[attempt.section_id]
    );
    if not exists (
      select 1 from public.project_sections sections
      where sections.owner_id = authenticated_owner and sections.project_id = attempt.project_id
        and sections.id = attempt.section_id and sections.status = 'active'
    ) then
      raise exception 'Project assets require an active section in the same owned Project.'
        using errcode = '42501';
    end if;
  end if;
  resource_type := case
    when attempt.mime_type like 'image/%' then 'image'
    when attempt.mime_type = 'application/pdf' then 'pdf'
    when attempt.mime_type like '%excel%' or attempt.mime_type like '%spreadsheet%' then 'spreadsheet'
    else 'document' end;
  insert into public.project_resources (
    owner_id, id, byte_size, created_at, height, mime_type, name, original_filename,
    project_id, resource_kind, role, section_id, source_metadata, status, storage_path,
    type, updated_at, width
  ) values (
    authenticated_owner, attempt.asset_id, attempt.byte_size, attempt.created_at,
    attempt.height, attempt.mime_type, attempt.original_filename, attempt.original_filename,
    attempt.project_id, 'uploaded_asset', 'reference', null,
    pg_catalog.jsonb_build_object('addedAt', attempt.created_at, 'kind', 'original-upload',
      'picker', attempt.source_picker),
    'current', attempt.storage_path, resource_type, attempt.created_at, attempt.width
  ) returning * into asset;
  if attempt.section_id is not null then
    insert into public.project_asset_section_placements(
      owner_id, project_id, asset_id, section_id, created_at
    ) values (
      authenticated_owner, attempt.project_id, attempt.asset_id,
      attempt.section_id, attempt.created_at
    );
    update public.project_resources
    set updated_at = attempt.created_at
    where owner_id = authenticated_owner and project_id = attempt.project_id
      and id = attempt.asset_id;
    select * into asset from public.project_resources resources
    where resources.owner_id = authenticated_owner and resources.project_id = attempt.project_id
      and resources.id = attempt.asset_id;
  end if;
  update public.project_asset_upload_attempts
    set status = 'finalized', finalized_at = now(), updated_at = now()
    where owner_id = authenticated_owner and attempt_id = p_attempt_id;
  return asset;
end;
$function$;

create or replace function public.reconcile_project_asset_uploads(p_project_id text, p_section_id text)
returns void language plpgsql security definer set search_path = '' as $function$
declare
  authenticated_owner uuid := auth.uid();
  pending record;
begin
  if authenticated_owner is null then
    raise exception 'Project asset reconciliation requires authentication.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.projects projects
    where projects.owner_id = authenticated_owner and projects.id = p_project_id
  ) then
    raise exception 'Project was not found.' using errcode = '42501';
  end if;
  if p_section_id is not null and not exists (
    select 1 from public.project_sections sections
    where sections.owner_id = authenticated_owner and sections.project_id = p_project_id
      and sections.id = p_section_id and sections.status = 'active'
  ) then
    raise exception 'Project assets require an active section in the same owned Project.'
      using errcode = '42501';
  end if;
  for pending in
    select attempts.attempt_id, attempts.storage_path
    from public.project_asset_upload_attempts attempts
    where attempts.owner_id = authenticated_owner and attempts.project_id = p_project_id
      and attempts.section_id is not distinct from p_section_id and attempts.status = 'pending'
    order by attempts.created_at, attempts.attempt_id
  loop
    if private.project_asset_storage_object_exists(pending.storage_path) then
      perform public.finalize_project_asset_upload(pending.attempt_id);
    end if;
  end loop;
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
  perform private.lock_project_asset_sections(authenticated_owner, p_project_id, array[p_section_id]);
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
    select * into asset from public.project_resources resources
    where resources.owner_id = authenticated_owner and resources.project_id = p_project_id
      and resources.id = p_asset_id;
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

  delete from public.project_asset_section_placements placements
  where placements.owner_id = authenticated_owner and placements.project_id = p_project_id
    and placements.asset_id = p_asset_id and placements.section_id = p_section_id;
  perform private.touch_project_asset_placement_activity(authenticated_owner, p_project_id);
  select * into asset from public.project_resources resources
  where resources.owner_id = authenticated_owner and resources.project_id = p_project_id
    and resources.id = p_asset_id;
  return asset;
end;
$function$;

create or replace function public.replace_project_asset_section(
  p_project_id text, p_asset_id text, p_source_section_id text, p_target_section_id text
) returns public.project_resources language plpgsql security definer set search_path = '' as $function$
declare
  authenticated_owner uuid := auth.uid();
  asset public.project_resources%rowtype;
  target_created_at timestamptz;
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
    select placements.created_at into target_created_at
    from public.project_asset_section_placements placements
    where placements.owner_id = authenticated_owner and placements.project_id = p_project_id
      and placements.asset_id = p_asset_id and placements.section_id = p_target_section_id;
    if found then
      delete from public.project_asset_section_placements placements
      where placements.owner_id = authenticated_owner and placements.project_id = p_project_id
        and placements.asset_id = p_asset_id and placements.section_id = p_target_section_id;
    end if;
    update public.project_asset_section_placements placements
    set section_id = p_target_section_id,
      created_at = coalesce(target_created_at, pg_catalog.clock_timestamp())
    where placements.owner_id = authenticated_owner and placements.project_id = p_project_id
      and placements.asset_id = p_asset_id and placements.section_id = p_source_section_id;
  else
    insert into public.project_asset_section_placements(owner_id, project_id, asset_id, section_id)
    values (authenticated_owner, p_project_id, p_asset_id, p_target_section_id)
    on conflict (owner_id, project_id, asset_id, section_id) do nothing;
    delete from public.project_asset_section_placements placements
    where placements.owner_id = authenticated_owner and placements.project_id = p_project_id
      and placements.asset_id = p_asset_id and placements.section_id = p_source_section_id;
  end if;
  perform private.touch_project_asset_placement_activity(authenticated_owner, p_project_id);
  select * into asset from public.project_resources resources
  where resources.owner_id = authenticated_owner and resources.project_id = p_project_id
    and resources.id = p_asset_id;
  return asset;
end;
$function$;

revoke all on function private.validate_project_asset_relationships() from public, anon, authenticated;
revoke all on function private.sync_project_asset_section_placement() from public, anon, authenticated;
revoke all on function private.sync_project_asset_compatibility_from_placement() from public, anon, authenticated;
revoke all on function private.backfill_project_asset_section_placements() from public, anon, authenticated;
revoke all on function public.begin_project_asset_upload(text,text,text,text,text,text,text,bigint,text,integer,integer) from public, anon;
revoke all on function public.finalize_project_asset_upload(text) from public, anon;
revoke all on function public.reconcile_project_asset_uploads(text,text) from public, anon;
revoke all on function public.add_project_asset_to_section(text,text,text) from public, anon;
revoke all on function public.remove_project_asset_from_section(text,text,text) from public, anon;
revoke all on function public.replace_project_asset_section(text,text,text,text) from public, anon;
grant execute on function public.begin_project_asset_upload(text,text,text,text,text,text,text,bigint,text,integer,integer) to authenticated;
grant execute on function public.finalize_project_asset_upload(text) to authenticated;
grant execute on function public.reconcile_project_asset_uploads(text,text) to authenticated;
grant execute on function public.add_project_asset_to_section(text,text,text) to authenticated;
grant execute on function public.remove_project_asset_from_section(text,text,text) to authenticated;
grant execute on function public.replace_project_asset_section(text,text,text,text) to authenticated;
