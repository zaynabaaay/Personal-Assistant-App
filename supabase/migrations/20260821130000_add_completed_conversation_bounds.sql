-- Apply processing input bounds to installations where completed-conversation
-- persistence was deployed before the mixed-topic processing hardening.

alter table public.completed_conversations
  add constraint completed_conversations_processing_message_count_bound
  check (message_count <= 50);

alter table public.conversation_messages
  add constraint conversation_messages_processing_content_bound
  check (length(content) <= 4000);

create function private.enforce_completed_conversation_processing_bounds()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  existing_character_count bigint;
  existing_message_count bigint;
begin
  select count(*), coalesce(sum(length(content)), 0)
  into existing_message_count, existing_character_count
  from public.conversation_messages
  where owner_id = new.owner_id and conversation_id = new.conversation_id;

  if existing_message_count >= 50 then
    raise exception 'A completed conversation cannot contain more than 50 messages.';
  end if;
  if existing_character_count + length(new.content) > 30000 then
    raise exception 'A completed conversation transcript cannot exceed 30000 characters.';
  end if;

  return new;
end;
$function$;

create trigger conversation_messages_processing_bounds
before insert on public.conversation_messages
for each row execute function private.enforce_completed_conversation_processing_bounds();
