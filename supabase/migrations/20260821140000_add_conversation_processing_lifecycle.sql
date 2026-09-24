-- Upgrade completed-conversation installations that predate the separate
-- mixed-topic Project processing lifecycle.

alter table public.completed_conversations
  add column if not exists processing_status text not null default 'pending'
    check (processing_status in ('pending', 'processing', 'processed', 'failed')),
  add column if not exists processing_attempts integer not null default 0
    check (processing_attempts >= 0),
  add column if not exists last_processing_error text,
  add column if not exists processing_plan jsonb;
