-- 口罩訂購助手 v2.1.0：帳號與密碼管理升級
-- 已執行過 v2.0.0 初始化者，請在 Supabase SQL Editor 執行本檔一次。

alter table public.mask_app_members
  add column if not exists must_change_password boolean not null default false;

drop function if exists public.mask_register_current_user();
create function public.mask_register_current_user()
returns table(approved boolean, role text, must_change_password boolean)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  is_first boolean;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select not exists(select 1 from public.mask_app_members) into is_first;
  insert into public.mask_app_members(user_id,email,role,approved,must_change_password)
  values (
    auth.uid(), coalesce(auth.jwt()->>'email',''),
    case when is_first then 'admin' else 'staff' end,
    is_first, false
  )
  on conflict (user_id) do update
    set email=excluded.email, updated_at=now();
  return query
  select m.approved,m.role,m.must_change_password
  from public.mask_app_members m where m.user_id=auth.uid();
end;
$$;

create or replace function public.mask_my_profile()
returns table(user_id uuid,email text,display_name text,role text,approved boolean,must_change_password boolean)
language sql
security definer
set search_path = public
as $$
  select m.user_id,m.email,m.display_name,m.role,m.approved,m.must_change_password
  from public.mask_app_members m where m.user_id=auth.uid();
$$;

create or replace function public.mask_mark_password_changed()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  update public.mask_app_members
  set must_change_password=false,updated_at=now()
  where user_id=auth.uid();
end;
$$;

revoke execute on function public.mask_register_current_user() from public,anon;
revoke execute on function public.mask_my_profile() from public,anon;
revoke execute on function public.mask_mark_password_changed() from public,anon;
grant execute on function public.mask_register_current_user() to authenticated;
grant execute on function public.mask_my_profile() to authenticated;
grant execute on function public.mask_mark_password_changed() to authenticated;

