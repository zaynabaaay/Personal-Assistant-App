-- Uploaded Project assets extend project_resources without changing legacy
-- link/reference semantics. Assets become authoritative only through finalization.

alter table public.project_resources
  add column byte_size bigint,
  add column height integer,
  add column original_filename text,
  add column resource_kind text not null default 'legacy',
  add column section_id text,
  add column source_metadata jsonb not null default '{}'::jsonb,
  add column status text not null default 'current',
  add column storage_path text,
  add column width integer;

alter table public.project_resources
  add constraint project_resources_status_check check (status in ('current', 'archived')),
  add constraint project_resources_kind_check check (resource_kind in ('legacy', 'uploaded_asset')),
  add constraint project_resources_byte_size_check
    check (byte_size is null or byte_size between 1 and 26214400),
  add constraint project_resources_dimensions_check check (
    (width is null and height is null) or (width > 0 and height > 0)
  ),
  add constraint project_resources_uploaded_shape_check check (
    (
      resource_kind = 'legacy' and storage_path is null and byte_size is null and
      original_filename is null and section_id is null and width is null and height is null
    ) or (
      resource_kind = 'uploaded_asset' and storage_path is not null and byte_size is not null and
      mime_type is not null and original_filename is not null and
      btrim(original_filename) = original_filename and
      char_length(original_filename) between 1 and 512 and section_id is not null and
      external_url is null and role = 'reference' and
      source_metadata->>'kind' = 'original-upload' and
      source_metadata->>'picker' in ('document-picker', 'photo-library', 'web-file-picker') and
      (
        (type = 'image' and mime_type like 'image/%' and width is not null and height is not null) or
        (type <> 'image' and width is null and height is null)
      )
    )
  ),
  add constraint project_resources_owner_project_id_unique unique (owner_id, project_id, id),
  add constraint project_resources_section_fk
    foreign key (owner_id, project_id, section_id)
    references public.project_sections(owner_id, project_id, id);

create unique index project_resources_storage_path_idx
  on public.project_resources(storage_path) where resource_kind = 'uploaded_asset';
create index project_resources_section_idx
  on public.project_resources(owner_id, project_id, section_id, status, created_at, id)
  where resource_kind = 'uploaded_asset';

create table public.project_asset_upload_attempts (
  owner_id uuid not null default auth.uid(),
  attempt_id text not null,
  asset_id text not null,
  byte_size bigint not null check (byte_size between 1 and 26214400),
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  height integer,
  mime_type text not null,
  object_id text not null,
  original_filename text not null check (
    original_filename = btrim(original_filename) and char_length(original_filename) between 1 and 512
  ),
  project_id text not null,
  section_id text not null,
  source_picker text not null check (
    source_picker in ('document-picker', 'photo-library', 'web-file-picker')
  ),
  status text not null default 'pending' check (status in ('pending', 'finalized', 'cleaned')),
  storage_path text not null,
  updated_at timestamptz not null default now(),
  width integer,
  primary key (owner_id, attempt_id),
  unique (owner_id, project_id, asset_id),
  unique (storage_path),
  foreign key (owner_id, project_id)
    references public.projects(owner_id, id) on delete cascade,
  foreign key (owner_id, project_id, section_id)
    references public.project_sections(owner_id, project_id, id),
  check ((width is null and height is null) or (width > 0 and height > 0))
);

alter table public.project_asset_upload_attempts enable row level security;
create policy project_asset_upload_attempts_owner_select
on public.project_asset_upload_attempts for select to authenticated
using (owner_id = (select auth.uid()));
revoke all on table public.project_asset_upload_attempts from public, anon, authenticated;
grant select on table public.project_asset_upload_attempts to authenticated;

-- Legacy resources retain direct writes. Uploaded rows can only be inserted by
-- finalize_project_asset_upload, whose SECURITY DEFINER owner bypasses RLS.
drop policy project_resources_owner_access on public.project_resources;
create policy project_resources_owner_select on public.project_resources
  for select to authenticated using (owner_id = (select auth.uid()));
create policy project_resources_owner_insert_legacy on public.project_resources
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and resource_kind = 'legacy');
create policy project_resources_owner_update on public.project_resources
  for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy project_resources_owner_delete_legacy on public.project_resources
  for delete to authenticated
  using (owner_id = (select auth.uid()) and resource_kind = 'legacy');

create function private.project_asset_path_matches(
  object_name text, expected_owner uuid, expected_project text,
  expected_asset text, expected_object text
) returns boolean
language sql immutable set search_path = ''
return object_name ~ '^[^/]+/[^/]+/[^/]+/[^/]+$'
  and pg_catalog.split_part(object_name, '/', 1) = expected_owner::text
  and pg_catalog.split_part(object_name, '/', 2) = expected_project
  and pg_catalog.split_part(object_name, '/', 3) = expected_asset
  and pg_catalog.split_part(object_name, '/', 4) = expected_object;

create function private.protect_project_asset_identity()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if old.resource_kind = 'uploaded_asset' or new.resource_kind = 'uploaded_asset' then
    if new.owner_id is distinct from old.owner_id or new.id is distinct from old.id
      or new.project_id is distinct from old.project_id
      or new.resource_kind is distinct from old.resource_kind
      or new.storage_path is distinct from old.storage_path
      or new.original_filename is distinct from old.original_filename
      or new.mime_type is distinct from old.mime_type
      or new.byte_size is distinct from old.byte_size
      or new.width is distinct from old.width or new.height is distinct from old.height
      or new.source_metadata is distinct from old.source_metadata
      or new.role is distinct from old.role or new.type is distinct from old.type
      or new.created_at is distinct from old.created_at then
      raise exception 'Project asset original source identity is immutable.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;
create trigger project_resources_protect_asset_identity before update on public.project_resources
for each row execute function private.protect_project_asset_identity();

create function private.validate_project_asset_relationships()
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
create trigger project_resources_validate_asset_relationships before insert or update
on public.project_resources for each row execute function private.validate_project_asset_relationships();

-- Dynamic SQL keeps unrelated embedded PostgreSQL tests independent of storage.*.
create function private.project_asset_storage_object_exists(object_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $function$
declare object_exists boolean := false;
begin
  if pg_catalog.to_regclass('storage.objects') is null then return false; end if;
  execute 'select exists (select 1 from storage.objects where bucket_id = $1 and name = $2)'
    into object_exists using 'project-assets', object_name;
  return object_exists;
end;
$function$;

create function public.begin_project_asset_upload(
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
    select 1 from public.project_sections sections
    where sections.owner_id = authenticated_owner and sections.project_id = p_project_id
      and sections.id = p_section_id and sections.status = 'active'
  ) then
    raise exception 'Project assets require an active section in the same owned Project.'
      using errcode = '42501';
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

create function public.finalize_project_asset_upload(p_attempt_id text)
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
  if not exists (
    select 1 from public.project_sections sections
    where sections.owner_id = authenticated_owner and sections.project_id = attempt.project_id
      and sections.id = attempt.section_id and sections.status = 'active'
  ) then
    raise exception 'Project assets require an active section in the same owned Project.' using errcode = '42501';
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
    attempt.project_id, 'uploaded_asset', 'reference', attempt.section_id,
    pg_catalog.jsonb_build_object('addedAt', attempt.created_at, 'kind', 'original-upload',
      'picker', attempt.source_picker),
    'current', attempt.storage_path, resource_type, attempt.created_at, attempt.width
  ) returning * into asset;
  update public.project_asset_upload_attempts
    set status = 'finalized', finalized_at = now(), updated_at = now()
    where owner_id = authenticated_owner and attempt_id = p_attempt_id;
  return asset;
end;
$function$;

create function public.mark_project_asset_upload_cleaned(p_attempt_id text)
returns void language plpgsql security definer set search_path = '' as $function$
declare authenticated_owner uuid := auth.uid(); attempt public.project_asset_upload_attempts%rowtype;
begin
  if authenticated_owner is null then
    raise exception 'Project asset cleanup requires authentication.' using errcode = '42501';
  end if;
  select * into attempt from public.project_asset_upload_attempts attempts
    where attempts.owner_id = authenticated_owner and attempts.attempt_id = p_attempt_id for update;
  if not found then raise exception 'Upload attempt was not found.' using errcode = '42501'; end if;
  if attempt.status = 'finalized' or exists (
    select 1 from public.project_resources resources
    where resources.owner_id = authenticated_owner and resources.resource_kind = 'uploaded_asset'
      and resources.storage_path = attempt.storage_path
  ) then raise exception 'A finalized Project asset cannot be cleaned.' using errcode = '42501'; end if;
  if private.project_asset_storage_object_exists(attempt.storage_path) then
    raise exception 'The Storage object must be removed through the Storage API first.';
  end if;
  update public.project_asset_upload_attempts set status = 'cleaned', updated_at = now()
    where owner_id = authenticated_owner and attempt_id = p_attempt_id;
end;
$function$;

create function public.reconcile_project_asset_uploads(p_project_id text, p_section_id text)
returns void language plpgsql security definer set search_path = '' as $function$
declare
  authenticated_owner uuid := auth.uid();
  pending record;
begin
  if authenticated_owner is null then
    raise exception 'Project asset reconciliation requires authentication.' using errcode = '42501';
  end if;
  if not exists (
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
      and attempts.section_id = p_section_id and attempts.status = 'pending'
    order by attempts.created_at, attempts.attempt_id
  loop
    if private.project_asset_storage_object_exists(pending.storage_path) then
      perform public.finalize_project_asset_upload(pending.attempt_id);
    end if;
  end loop;
end;
$function$;

create function private.can_upload_project_asset_object(object_name text)
returns boolean language sql stable security definer set search_path = ''
return auth.uid() is not null and exists (
  select 1 from public.project_asset_upload_attempts attempts
  where attempts.owner_id = auth.uid() and attempts.status = 'pending'
    and attempts.storage_path = object_name
    and private.project_asset_path_matches(
      object_name, attempts.owner_id, attempts.project_id, attempts.asset_id, attempts.object_id
    )
);
create function private.can_read_project_asset_object(object_name text)
returns boolean language sql stable security definer set search_path = ''
return auth.uid() is not null and exists (
  select 1 from public.project_resources resources
  where resources.owner_id = auth.uid() and resources.resource_kind = 'uploaded_asset'
    and resources.storage_path = object_name
    and private.project_asset_path_matches(
      object_name, resources.owner_id, resources.project_id, resources.id,
      pg_catalog.split_part(object_name, '/', 4)
    )
);
create function private.can_delete_pending_project_asset_object(object_name text)
returns boolean language sql stable security definer set search_path = ''
return private.can_upload_project_asset_object(object_name) and not exists (
  select 1 from public.project_resources resources
  where resources.owner_id = auth.uid() and resources.resource_kind = 'uploaded_asset'
    and resources.storage_path = object_name
);

revoke all on function private.project_asset_path_matches(text,uuid,text,text,text) from public, anon;
revoke all on function private.project_asset_storage_object_exists(text) from public, anon, authenticated;
revoke all on function private.can_upload_project_asset_object(text) from public, anon;
revoke all on function private.can_read_project_asset_object(text) from public, anon;
revoke all on function private.can_delete_pending_project_asset_object(text) from public, anon;
grant execute on function private.project_asset_path_matches(text,uuid,text,text,text) to authenticated;
grant execute on function private.can_upload_project_asset_object(text) to authenticated;
grant execute on function private.can_read_project_asset_object(text) to authenticated;
grant execute on function private.can_delete_pending_project_asset_object(text) to authenticated;
revoke all on function public.begin_project_asset_upload(text,text,text,text,text,text,text,bigint,text,integer,integer) from public, anon;
revoke all on function public.finalize_project_asset_upload(text) from public, anon;
revoke all on function public.mark_project_asset_upload_cleaned(text) from public, anon;
revoke all on function public.reconcile_project_asset_uploads(text,text) from public, anon;
grant execute on function public.begin_project_asset_upload(text,text,text,text,text,text,text,bigint,text,integer,integer) to authenticated;
grant execute on function public.finalize_project_asset_upload(text) to authenticated;
grant execute on function public.mark_project_asset_upload_cleaned(text) to authenticated;
grant execute on function public.reconcile_project_asset_uploads(text,text) to authenticated;

do $storage_setup$
begin
  if pg_catalog.to_regclass('storage.buckets') is not null
    and pg_catalog.to_regclass('storage.objects') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('project-assets', 'project-assets', false, 26214400, array[
      'application/msword', 'application/pdf', 'application/rtf',
      'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/gif', 'image/heic', 'image/heif', 'image/jpeg', 'image/png', 'image/webp', 'text/plain'
    ]) on conflict (id) do update set public = excluded.public,
      file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
    execute $policy$ create policy project_assets_exact_select on storage.objects
      for select to authenticated using (
        bucket_id = 'project-assets' and
        ((select private.can_read_project_asset_object(name)) or
         (select private.can_upload_project_asset_object(name)))
      ) $policy$;
    execute $policy$ create policy project_assets_pending_insert on storage.objects
      for insert to authenticated with check (
        bucket_id = 'project-assets' and (select private.can_upload_project_asset_object(name))
      ) $policy$;
    execute $policy$ create policy project_assets_pending_delete on storage.objects
      for delete to authenticated using (
        bucket_id = 'project-assets' and (select private.can_delete_pending_project_asset_object(name))
      ) $policy$;
  end if;
end;
$storage_setup$;

-- Generic atomic Project writes remain available for legacy resources only.
create or replace function public.commit_project_changes(p_changes jsonb)
returns void language plpgsql security definer set search_path = '' as $function$
declare authenticated_owner uuid := auth.uid();
begin
  if authenticated_owner is null then
    raise exception 'Project writes require an authenticated user.' using errcode = '42501';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(coalesce(p_changes->'resources', '[]'::jsonb)) resource
    where coalesce(resource->>'resource_kind', 'legacy') <> 'legacy'
      or resource->>'storage_path' is not null or resource->>'original_filename' is not null
      or resource->>'byte_size' is not null
  ) then
    raise exception 'Uploaded assets must use the authoritative upload finalization RPC.'
      using errcode = '42501';
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
