-- Project organization is a separate, retryable lifecycle after a completed
-- conversation has already been durably saved.

alter table public.project_work_sessions
  add column source_conversation_id text;

alter table public.project_work_sessions
  add constraint project_work_sessions_source_conversation_fk
  foreign key (owner_id, source_conversation_id)
  references public.completed_conversations(owner_id, id);

create unique index project_work_sessions_source_conversation_idx
  on public.project_work_sessions(owner_id, project_id, source_conversation_id)
  where source_conversation_id is not null;

alter table public.project_tasks add column derived_identity text
  check (derived_identity is null or length(derived_identity) between 1 and 100);
alter table public.project_knowledge_items add column derived_identity text
  check (derived_identity is null or length(derived_identity) between 1 and 100);
alter table public.project_decisions add column derived_identity text
  check (derived_identity is null or length(derived_identity) between 1 and 100);

create unique index project_tasks_derived_identity_idx
  on public.project_tasks(owner_id, project_id, derived_identity)
  where derived_identity is not null and status <> 'cancelled';
create unique index project_knowledge_derived_identity_idx
  on public.project_knowledge_items(owner_id, project_id, kind, derived_identity)
  where derived_identity is not null and status = 'current';
create unique index project_decisions_derived_identity_idx
  on public.project_decisions(owner_id, project_id, derived_identity)
  where derived_identity is not null and status = 'active';

create table public.conversation_project_processing (
  owner_id uuid not null default auth.uid(),
  conversation_id text not null,
  project_id text not null,
  session_id text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'processed', 'skipped', 'failed')),
  processing_attempts integer not null default 0 check (processing_attempts >= 0),
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (owner_id, conversation_id, project_id),
  foreign key (owner_id, conversation_id)
    references public.completed_conversations(owner_id, id) on delete cascade
);

create table public.pending_project_candidates (
  owner_id uuid not null default auth.uid(),
  id text not null,
  project_id text not null,
  conversation_id text not null,
  session_id text not null,
  content text not null check (length(content) > 0),
  status text not null default 'pending' check (status = 'pending'),
  created_at timestamptz not null,
  primary key (owner_id, id),
  foreign key (owner_id, project_id)
    references public.projects(owner_id, id) on delete cascade,
  foreign key (owner_id, conversation_id)
    references public.completed_conversations(owner_id, id) on delete cascade,
  foreign key (owner_id, project_id, session_id)
    references public.project_work_sessions(owner_id, project_id, id) on delete cascade
);

create index conversation_project_processing_status_idx
  on public.conversation_project_processing(owner_id, conversation_id, status);
create index pending_project_candidates_project_idx
  on public.pending_project_candidates(owner_id, project_id, created_at, id);

alter table public.conversation_project_processing enable row level security;
alter table public.pending_project_candidates enable row level security;

create policy conversation_project_processing_owner_access
  on public.conversation_project_processing for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy pending_project_candidates_owner_access
  on public.pending_project_candidates for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

revoke all on table public.conversation_project_processing from anon;
revoke all on table public.pending_project_candidates from anon;
grant select on table public.conversation_project_processing to authenticated;
grant select on table public.pending_project_candidates to authenticated;

create function public.claim_conversation_project_processing(p_conversation_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_owner uuid := auth.uid();
  current_status text;
  current_plan jsonb;
  current_updated_at timestamptz;
begin
  if authenticated_owner is null then
    raise exception 'Conversation processing requires an authenticated user.'
      using errcode = '42501';
  end if;

  select processing_status, processing_plan, updated_at
  into current_status, current_plan, current_updated_at
  from public.completed_conversations
  where owner_id = authenticated_owner and id = p_conversation_id
  for update;

  if current_status is null then
    raise exception 'Completed conversation was not found.';
  end if;

  if current_status = 'processed' then
    return current_status;
  end if;

  if current_plan is not null then
    return 'reuse';
  end if;

  if current_status = 'processing'
    and current_updated_at > now() - interval '15 minutes' then
    return 'waiting';
  end if;

  update public.completed_conversations
  set processing_status = 'processing',
      processing_attempts = processing_attempts + 1,
      last_processing_error = null,
      updated_at = now()
  where owner_id = authenticated_owner and id = p_conversation_id;

  update public.conversation_project_processing
  set status = case when status in ('processed', 'skipped') then status else 'processing' end,
      processing_attempts = case
        when status in ('processed', 'skipped') then processing_attempts
        else processing_attempts + 1
      end,
      last_error = case when status in ('processed', 'skipped') then last_error else null end,
      updated_at = now()
  where owner_id = authenticated_owner and conversation_id = p_conversation_id;

  return 'processing';
end;
$function$;

create function public.save_conversation_project_plan(
  p_conversation_id text,
  p_plan jsonb,
  p_projects jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_owner uuid := auth.uid();
  existing_plan jsonb;
  item jsonb;
begin
  if authenticated_owner is null then
    raise exception 'Conversation processing requires an authenticated user.'
      using errcode = '42501';
  end if;
  if jsonb_typeof(p_plan) <> 'object' or jsonb_typeof(p_projects) <> 'array' then
    raise exception 'Conversation Project plan is invalid.';
  end if;

  select processing_plan into existing_plan
  from public.completed_conversations
  where owner_id = authenticated_owner and id = p_conversation_id
  for update;

  if existing_plan is not null then
    return existing_plan;
  end if;

  update public.completed_conversations
  set processing_plan = coalesce(processing_plan, p_plan), updated_at = now()
  where owner_id = authenticated_owner and id = p_conversation_id;

  for item in select value from jsonb_array_elements(p_projects)
  loop
    insert into public.conversation_project_processing (
      owner_id, conversation_id, project_id, session_id, status,
      processing_attempts, updated_at
    ) values (
      authenticated_owner, p_conversation_id, item->>'project_id',
      item->>'session_id', 'processing', 1, now()
    ) on conflict (owner_id, conversation_id, project_id) do nothing;
  end loop;
  return p_plan;
end;
$function$;

create function public.commit_conversation_project_result(
  p_conversation_id text,
  p_project_id text,
  p_changes jsonb,
  p_candidates jsonb,
  p_preconditions jsonb
) returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_owner uuid := auth.uid();
  checkpoint_status text;
  checkpoint_session_id text;
  item jsonb;
  project_status text;
begin
  if authenticated_owner is null then
    raise exception 'Conversation processing requires an authenticated user.'
      using errcode = '42501';
  end if;

  if jsonb_typeof(p_changes) <> 'object' or jsonb_typeof(p_candidates) <> 'array'
    or jsonb_typeof(p_preconditions) <> 'array' then
    raise exception 'Conversation Project commit payload is invalid.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(authenticated_owner::text || ':' || p_project_id, 0)
  );

  select status, session_id into checkpoint_status, checkpoint_session_id
  from public.conversation_project_processing
  where owner_id = authenticated_owner
    and conversation_id = p_conversation_id
    and project_id = p_project_id
  for update;

  if checkpoint_status is null then
    raise exception 'Conversation Project checkpoint was not found.';
  end if;
  if checkpoint_status = 'processed' then
    return 'processed';
  end if;
  if checkpoint_status = 'skipped' then
    return 'skipped';
  end if;

  select status into project_status
  from public.projects
  where owner_id = authenticated_owner and id = p_project_id
  for update;

  if project_status is null or project_status in ('archived', 'cancelled') then
    update public.conversation_project_processing
    set status = 'skipped', last_error = 'Project is no longer eligible.', updated_at = now()
    where owner_id = authenticated_owner and conversation_id = p_conversation_id
      and project_id = p_project_id;
    return 'skipped';
  end if;

  if exists (
    select 1 from jsonb_array_elements(coalesce(p_changes->'work_sessions', '[]'::jsonb)) value
    where value->>'project_id' is distinct from p_project_id
      or value->>'source_conversation_id' is distinct from p_conversation_id
      or value->>'id' is distinct from checkpoint_session_id
  ) or exists (
    select 1 from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb)) value
    where value->>'project_id' is distinct from p_project_id
      or value->>'conversation_id' is distinct from p_conversation_id
      or value->>'session_id' is distinct from checkpoint_session_id
  ) or exists (
    select 1 from (
      select value from jsonb_array_elements(coalesce(p_changes->'tasks', '[]'::jsonb))
      union all select value from jsonb_array_elements(coalesce(p_changes->'knowledge_items', '[]'::jsonb))
      union all select value from jsonb_array_elements(coalesce(p_changes->'decisions', '[]'::jsonb))
      union all select value from jsonb_array_elements(coalesce(p_changes->'change_events', '[]'::jsonb))
    ) changed where changed.value->>'project_id' is distinct from p_project_id
  ) or jsonb_array_length(coalesce(p_changes->'projects', '[]'::jsonb)) > 0
    or jsonb_array_length(coalesce(p_changes->'milestones', '[]'::jsonb)) > 0
    or jsonb_array_length(coalesce(p_changes->'deliverables', '[]'::jsonb)) > 0
    or jsonb_array_length(coalesce(p_changes->'resources', '[]'::jsonb)) > 0
    or jsonb_array_length(coalesce(p_changes->'work_session_entries', '[]'::jsonb)) > 0
  then
    raise exception 'Conversation Project commit crossed its Project boundary.'
      using errcode = '42501';
  end if;

  for item in select value from jsonb_array_elements(p_preconditions)
  loop
    if item->>'operation' = 'create' and item->>'entityType' = 'task' and exists (
      select 1 from public.project_tasks where owner_id = authenticated_owner
        and project_id = p_project_id and derived_identity = item->>'derivedIdentity'
        and status <> 'cancelled'
    ) then raise exception 'Project state changed after analysis.' using errcode = '40001';
    elsif item->>'operation' = 'create' and item->>'entityType' = 'knowledge' and exists (
      select 1 from public.project_knowledge_items where owner_id = authenticated_owner
        and project_id = p_project_id and derived_identity = item->>'derivedIdentity'
        and kind = item->>'knowledgeKind' and status = 'current'
    ) then raise exception 'Project state changed after analysis.' using errcode = '40001';
    elsif item->>'operation' = 'create' and item->>'entityType' = 'decision' and exists (
      select 1 from public.project_decisions where owner_id = authenticated_owner
        and project_id = p_project_id and derived_identity = item->>'derivedIdentity'
        and status = 'active'
    ) then raise exception 'Project state changed after analysis.' using errcode = '40001';
    elsif item->>'operation' = 'replace' and item->>'entityType' = 'knowledge' and not exists (
      select 1 from public.project_knowledge_items where owner_id = authenticated_owner
        and project_id = p_project_id and id = item->>'existingEntityId'
        and status = 'current' and updated_at = (item->>'expectedUpdatedAt')::timestamptz
    ) then raise exception 'Project replacement is stale.' using errcode = '40001';
    elsif item->>'operation' = 'replace' and item->>'entityType' = 'decision' and not exists (
      select 1 from public.project_decisions where owner_id = authenticated_owner
        and project_id = p_project_id and id = item->>'existingEntityId'
        and status = 'active' and updated_at = (item->>'expectedUpdatedAt')::timestamptz
    ) then raise exception 'Project replacement is stale.' using errcode = '40001';
    end if;
  end loop;

  perform private.upsert_owned_project_rows('public.projects', coalesce(p_changes->'projects', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_milestones', coalesce(p_changes->'milestones', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_deliverables', coalesce(p_changes->'deliverables', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_work_sessions', coalesce(p_changes->'work_sessions', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_tasks', coalesce(p_changes->'tasks', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_knowledge_items', (
    select coalesce(jsonb_agg(value), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_changes->'knowledge_items', '[]'::jsonb)) value
    where value->>'status' <> 'current'
  ), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_knowledge_items', (
    select coalesce(jsonb_agg(value), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_changes->'knowledge_items', '[]'::jsonb)) value
    where value->>'status' = 'current'
  ), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_decisions', (
    select coalesce(jsonb_agg(value), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_changes->'decisions', '[]'::jsonb)) value
    where value->>'status' <> 'active'
  ), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_decisions', (
    select coalesce(jsonb_agg(value), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_changes->'decisions', '[]'::jsonb)) value
    where value->>'status' = 'active'
  ), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_resources', coalesce(p_changes->'resources', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_work_session_entries', coalesce(p_changes->'work_session_entries', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.project_change_events', coalesce(p_changes->'change_events', '[]'::jsonb), authenticated_owner);
  perform private.upsert_owned_project_rows('public.pending_project_candidates', coalesce(p_candidates, '[]'::jsonb), authenticated_owner);

  update public.conversation_project_processing
  set status = 'processed', last_error = null, updated_at = now()
  where owner_id = authenticated_owner
    and conversation_id = p_conversation_id
    and project_id = p_project_id;
  return 'processed';
end;
$function$;

create function public.fail_conversation_project_processing(
  p_conversation_id text,
  p_project_id text,
  p_error text
) returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_owner uuid := auth.uid();
begin
  if authenticated_owner is null then
    raise exception 'Conversation processing requires an authenticated user.'
      using errcode = '42501';
  end if;

  update public.completed_conversations
  set processing_status = 'failed', last_processing_error = left(p_error, 1000),
      updated_at = now()
  where owner_id = authenticated_owner and id = p_conversation_id
    and processing_status <> 'processed';

  if p_project_id is not null then
    update public.conversation_project_processing
    set status = case when status in ('processed', 'skipped') then status else 'failed' end,
        last_error = case when status in ('processed', 'skipped') then last_error else left(p_error, 1000) end,
        updated_at = now()
    where owner_id = authenticated_owner and conversation_id = p_conversation_id
      and project_id = p_project_id;
  end if;
end;
$function$;

create function public.complete_conversation_project_processing(p_conversation_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  authenticated_owner uuid := auth.uid();
begin
  if authenticated_owner is null then
    raise exception 'Conversation processing requires an authenticated user.'
      using errcode = '42501';
  end if;
  if exists (
    select 1 from public.conversation_project_processing
    where owner_id = authenticated_owner and conversation_id = p_conversation_id
      and status not in ('processed', 'skipped')
  ) then
    raise exception 'Conversation Project processing is incomplete.';
  end if;
  if not exists (
    select 1 from public.completed_conversations
    where owner_id = authenticated_owner and id = p_conversation_id
      and processing_plan is not null
  ) then
    raise exception 'Conversation Project plan was not saved.';
  end if;

  update public.completed_conversations
  set processing_status = 'processed', last_processing_error = null, updated_at = now()
  where owner_id = authenticated_owner and id = p_conversation_id;
end;
$function$;

revoke all on function public.claim_conversation_project_processing(text) from public, anon;
revoke all on function public.save_conversation_project_plan(text, jsonb, jsonb) from public, anon;
revoke all on function public.commit_conversation_project_result(text, text, jsonb, jsonb, jsonb) from public, anon;
revoke all on function public.fail_conversation_project_processing(text, text, text) from public, anon;
revoke all on function public.complete_conversation_project_processing(text) from public, anon;
grant execute on function public.claim_conversation_project_processing(text) to authenticated;
grant execute on function public.save_conversation_project_plan(text, jsonb, jsonb) to authenticated;
grant execute on function public.commit_conversation_project_result(text, text, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.fail_conversation_project_processing(text, text, text) to authenticated;
grant execute on function public.complete_conversation_project_processing(text) to authenticated;
