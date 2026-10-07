-- =====================================================================
-- 賭讀 / StudyBet — 03_storage.sql
-- Private bucket "proofs": {room_id}/{task_id}.jpg, image/jpeg, max 300 KB.
-- Only the two members of the room can read; only the task owner can
-- upload / replace / remove, and only while the task is still active.
-- Clients view proofs through signed URLs (createSignedUrl(path, 60)).
-- Run after 02_rls_and_rpc.sql. Safe to re-run.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('proofs', 'proofs', false, 307200, array['image/jpeg'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = 307200,
      allowed_mime_types = array['image/jpeg'];

-- p_write = false: may the caller READ this object?  (same room)
-- p_write = true : may the caller WRITE it?          (own task, still active)
create or replace function public.proof_object_allowed(p_name text, p_write bool)
returns boolean
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_room uuid := public.my_room_id();
  v_task uuid;
begin
  -- separate IFs: the uuid casts below must only run on names that passed the regex
  if v_room is null or p_name is null then
    return false;
  end if;
  if p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$' then
    return false;
  end if;
  if split_part(p_name, '/', 1)::uuid <> v_room then
    return false;
  end if;
  if not p_write then
    return true;
  end if;
  v_task := split_part(split_part(p_name, '/', 2), '.', 1)::uuid;
  return exists (
    select 1 from public.tasks
    where id = v_task and room_id = v_room and owner_id = auth.uid()
      and status = 'active' and deleted_at is null
  );
end $$;

revoke all on function public.proof_object_allowed(text, bool) from public, anon;
grant execute on function public.proof_object_allowed(text, bool) to authenticated;

drop policy if exists "studybet proofs read"   on storage.objects;
drop policy if exists "studybet proofs insert" on storage.objects;
drop policy if exists "studybet proofs update" on storage.objects;
drop policy if exists "studybet proofs delete" on storage.objects;

create policy "studybet proofs read" on storage.objects
  for select to authenticated
  using (bucket_id = 'proofs' and public.proof_object_allowed(name, false));

create policy "studybet proofs insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'proofs' and public.proof_object_allowed(name, true));

create policy "studybet proofs update" on storage.objects
  for update to authenticated
  using      (bucket_id = 'proofs' and public.proof_object_allowed(name, true))
  with check (bucket_id = 'proofs' and public.proof_object_allowed(name, true));

create policy "studybet proofs delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'proofs' and public.proof_object_allowed(name, true));
