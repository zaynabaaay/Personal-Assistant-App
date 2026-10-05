-- The Projects domain uses opaque string IDs. owner_id is persistence metadata and
-- is intentionally not part of the TypeScript domain model.

create table public.projects (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  completed_at timestamptz,
  created_at timestamptz not null,
  description text,
  goal text,
  name text not null,
  priority text not null check (priority in ('low', 'normal', 'high', 'urgent')),
  start_date date,
  status text not null check (status in ('planned', 'active', 'paused', 'completed', 'cancelled', 'archived')),
  target_date date,
  timezone text not null,
  type text not null check (type in ('general', 'grant', 'website', 'story', 'event', 'business', 'other')),
  updated_at timestamptz not null,
  primary key (owner_id, id)
);

create table public.project_milestones (
  owner_id uuid not null default auth.uid(),
  id text not null,
  completed_at timestamptz,
  created_at timestamptz not null,
  description text,
  name text not null,
  position integer not null,
  project_id text not null,
  status text not null check (status in ('planned', 'active', 'completed', 'cancelled')),
  target_date date,
  updated_at timestamptz not null,
  primary key (owner_id, id),
  unique (owner_id, project_id, id),
  foreign key (owner_id, project_id) references public.projects(owner_id, id) on delete cascade
);

create table public.project_deliverables (
  owner_id uuid not null default auth.uid(),
  id text not null,
  completed_at timestamptz,
  created_at timestamptz not null,
  description text,
  due_date date,
  milestone_id text,
  name text not null,
  position integer not null,
  project_id text not null,
  status text not null check (status in ('planned', 'in_progress', 'review', 'completed', 'cancelled')),
  updated_at timestamptz not null,
  primary key (owner_id, id),
  unique (owner_id, project_id, id),
  foreign key (owner_id, project_id) references public.projects(owner_id, id) on delete cascade,
  foreign key (owner_id, project_id, milestone_id) references public.project_milestones(owner_id, project_id, id)
);

create table public.project_work_sessions (
  owner_id uuid not null default auth.uid(),
  id text not null,
  created_at timestamptz not null,
  ended_at timestamptz,
  project_id text not null,
  started_at timestamptz not null,
  summary text,
  title text,
  updated_at timestamptz not null,
  primary key (owner_id, id),
  unique (owner_id, project_id, id),
  foreign key (owner_id, project_id) references public.projects(owner_id, id) on delete cascade,
  check (ended_at is null or ended_at >= started_at)
);

create table public.project_tasks (
  owner_id uuid not null default auth.uid(),
  id text not null,
  completed_at timestamptz,
  created_at timestamptz not null,
  deliverable_id text,
  description text,
  due_date date,
  milestone_id text,
  parent_task_id text,
  position integer not null,
  priority text not null check (priority in ('low', 'normal', 'high', 'urgent')),
  project_id text not null,
  scheduled_for timestamptz,
  source_session_id text,
  status text not null check (status in ('todo', 'in_progress', 'blocked', 'completed', 'cancelled')),
  title text not null,
  updated_at timestamptz not null,
  primary key (owner_id, id),
  unique (owner_id, project_id, id),
  foreign key (owner_id, project_id) references public.projects(owner_id, id) on delete cascade,
  foreign key (owner_id, project_id, milestone_id) references public.project_milestones(owner_id, project_id, id),
  foreign key (owner_id, project_id, deliverable_id) references public.project_deliverables(owner_id, project_id, id),
  foreign key (owner_id, project_id, parent_task_id) references public.project_tasks(owner_id, project_id, id),
  foreign key (owner_id, project_id, source_session_id) references public.project_work_sessions(owner_id, project_id, id)
);

create table public.project_knowledge_items (
  owner_id uuid not null default auth.uid(),
  id text not null,
  content text not null,
  created_at timestamptz not null,
  kind text not null check (kind in ('fact', 'requirement', 'constraint', 'note', 'question')),
  project_id text not null,
  resolution text,
  resolved_at timestamptz,
  source_session_id text,
  status text not null check (status in ('proposed', 'current', 'resolved', 'superseded', 'archived')),
  supersedes_knowledge_item_id text,
  title text,
  updated_at timestamptz not null,
  primary key (owner_id, id),
  unique (owner_id, project_id, id),
  foreign key (owner_id, project_id) references public.projects(owner_id, id) on delete cascade,
  foreign key (owner_id, project_id, source_session_id) references public.project_work_sessions(owner_id, project_id, id),
  foreign key (owner_id, project_id, supersedes_knowledge_item_id) references public.project_knowledge_items(owner_id, project_id, id)
);

create table public.project_decisions (
  owner_id uuid not null default auth.uid(),
  id text not null,
  created_at timestamptz not null,
  decided_at timestamptz not null,
  project_id text not null,
  rationale text,
  source_session_id text,
  statement text not null,
  status text not null check (status in ('active', 'superseded', 'reversed')),
  supersedes_decision_id text,
  updated_at timestamptz not null,
  primary key (owner_id, id),
  unique (owner_id, project_id, id),
  foreign key (owner_id, project_id) references public.projects(owner_id, id) on delete cascade,
  foreign key (owner_id, project_id, source_session_id) references public.project_work_sessions(owner_id, project_id, id),
  foreign key (owner_id, project_id, supersedes_decision_id) references public.project_decisions(owner_id, project_id, id)
);

create table public.project_resources (
  owner_id uuid not null default auth.uid(),
  id text not null,
  created_at timestamptz not null,
  description text,
  external_url text,
  mime_type text,
  name text not null,
  project_id text not null,
  role text not null check (role in ('reference', 'working')),
  source_session_id text,
  type text not null check (type in ('document', 'pdf', 'spreadsheet', 'image', 'link', 'other')),
  updated_at timestamptz not null,
  primary key (owner_id, id),
  foreign key (owner_id, project_id) references public.projects(owner_id, id) on delete cascade,
  foreign key (owner_id, project_id, source_session_id) references public.project_work_sessions(owner_id, project_id, id)
);

create table public.project_work_session_entries (
  owner_id uuid not null default auth.uid(),
  id text not null,
  content text not null,
  kind text not null check (kind in ('user_message', 'assistant_message', 'note', 'activity')),
  occurred_at timestamptz not null,
  position integer not null,
  project_id text not null,
  session_id text not null,
  primary key (owner_id, id),
  foreign key (owner_id, project_id) references public.projects(owner_id, id) on delete cascade,
  foreign key (owner_id, project_id, session_id) references public.project_work_sessions(owner_id, project_id, id) on delete cascade
);

create table public.project_change_events (
  owner_id uuid not null default auth.uid(),
  id text not null,
  after_state jsonb,
  before_state jsonb,
  entity_id text not null,
  entity_type text not null check (entity_type in ('task', 'knowledge', 'decision', 'work_session')),
  event_type text not null check (event_type in ('task_completed', 'knowledge_accepted', 'knowledge_superseded', 'decision_superseded', 'work_session_closed')),
  occurred_at timestamptz not null,
  project_id text not null,
  source_session_id text,
  summary text not null,
  primary key (owner_id, id),
  foreign key (owner_id, project_id) references public.projects(owner_id, id) on delete cascade,
  foreign key (owner_id, project_id, source_session_id) references public.project_work_sessions(owner_id, project_id, id)
);

create index project_milestones_order_idx on public.project_milestones(owner_id, project_id, position, id);
create index project_deliverables_order_idx on public.project_deliverables(owner_id, project_id, position, id);
create index project_tasks_order_idx on public.project_tasks(owner_id, project_id, position, id);
create index project_work_sessions_order_idx on public.project_work_sessions(owner_id, project_id, started_at, id);
create index project_work_session_entries_order_idx on public.project_work_session_entries(owner_id, session_id, position, occurred_at, id);
create index project_change_events_order_idx on public.project_change_events(owner_id, project_id, occurred_at, id);
create index project_knowledge_project_idx on public.project_knowledge_items(owner_id, project_id);
create index project_decisions_project_idx on public.project_decisions(owner_id, project_id);
create index project_resources_project_idx on public.project_resources(owner_id, project_id);

do $policies$
declare
  table_name text;
begin
  foreach table_name in array array[
    'projects', 'project_milestones', 'project_deliverables', 'project_tasks',
    'project_knowledge_items', 'project_decisions', 'project_work_sessions',
    'project_work_session_entries', 'project_resources', 'project_change_events'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'create policy %I on public.%I for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()))',
      table_name || '_owner_access', table_name
    );
    execute format('revoke all on table public.%I from anon', table_name);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', table_name);
  end loop;
end;
$policies$;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Called only by the public fixed-table RPC below. It replaces any supplied
-- owner_id with the verified JWT identity before each upsert.
create function private.upsert_owned_project_rows(
  target_table regclass,
  input_rows jsonb,
  authenticated_owner uuid
) returns void
language plpgsql
set search_path = ''
as $function$
declare
  assignments text;
  owned_rows jsonb;
begin
  if jsonb_typeof(input_rows) <> 'array' then
    raise exception 'Project change-set members must be arrays.';
  end if;

  select coalesce(
    jsonb_agg(value || jsonb_build_object('owner_id', authenticated_owner)),
    '[]'::jsonb
  ) into owned_rows
  from jsonb_array_elements(input_rows);

  select string_agg(format('%1$I = excluded.%1$I', attribute.attname), ', ')
  into assignments
  from pg_catalog.pg_attribute attribute
  where attribute.attrelid = target_table
    and attribute.attnum > 0
    and not attribute.attisdropped
    and attribute.attname not in ('owner_id', 'id');

  execute format(
    'insert into %1$s select * from jsonb_populate_recordset(null::%1$s, $1) on conflict (owner_id, id) do update set %2$s',
    target_table,
    assignments
  ) using owned_rows;
end;
$function$;

create function public.commit_project_changes(p_changes jsonb)
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
