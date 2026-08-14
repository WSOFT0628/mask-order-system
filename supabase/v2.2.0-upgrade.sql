-- 口罩訂購助手 v2.2.0：自訂帳號、角色權限與安全規則
-- 請在已完成 v2.0.0 / v2.1.0 的 Supabase 專案執行一次。

alter table public.mask_app_members
  add column if not exists username text,
  add column if not exists contact_email text;

create unique index if not exists mask_app_members_username_key
  on public.mask_app_members (lower(username)) where username is not null;

create table if not exists public.mask_role_permissions (
  role text primary key check (role in ('admin','staff','viewer')),
  permissions jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.mask_role_permissions(role,permissions) values
('admin','{"product_view":true,"order_edit":true,"order_save":true,"order_export":true,"record_view":true,"record_apply":true,"record_delete":true,"catalog_manage":true,"price_manage":true,"settings_manage":true,"backup_manage":true,"account_manage":true,"permission_manage":true}'::jsonb),
('staff','{"product_view":true,"order_edit":true,"order_save":true,"order_export":true,"record_view":true,"record_apply":true,"record_delete":false,"catalog_manage":false,"price_manage":false,"settings_manage":false,"backup_manage":false,"account_manage":false,"permission_manage":false}'::jsonb),
('viewer','{"product_view":true,"order_edit":false,"order_save":false,"order_export":true,"record_view":true,"record_apply":false,"record_delete":false,"catalog_manage":false,"price_manage":false,"settings_manage":false,"backup_manage":false,"account_manage":false,"permission_manage":false}'::jsonb)
on conflict (role) do nothing;

alter table public.mask_role_permissions enable row level security;
drop policy if exists mask_role_permissions_read on public.mask_role_permissions;
create policy mask_role_permissions_read on public.mask_role_permissions
for select to authenticated using (
  exists(select 1 from public.mask_app_members m where m.user_id=auth.uid() and m.approved)
);

create or replace function public.mask_has_permission(p_permission text)
returns boolean language sql stable security definer set search_path=public as $$
  select coalesce((rp.permissions->>p_permission)::boolean,false)
  from public.mask_app_members m
  join public.mask_role_permissions rp on rp.role=m.role
  where m.user_id=auth.uid() and m.approved;
$$;

drop function if exists public.mask_register_current_user();
create function public.mask_register_current_user()
returns table(approved boolean,role text,must_change_password boolean,username text,display_name text,permissions jsonb)
language plpgsql security definer set search_path=public,auth as $$
declare is_first boolean;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select not exists(select 1 from public.mask_app_members) into is_first;
  insert into public.mask_app_members(user_id,email,contact_email,role,approved,must_change_password)
  values(auth.uid(),coalesce(auth.jwt()->>'email',''),coalesce(auth.jwt()->>'email',''),case when is_first then 'admin' else 'staff' end,is_first,false)
  on conflict(user_id) do update set updated_at=now();
  return query select m.approved,m.role,m.must_change_password,m.username,m.display_name,r.permissions
  from public.mask_app_members m join public.mask_role_permissions r on r.role=m.role
  where m.user_id=auth.uid();
end; $$;

drop function if exists public.mask_my_profile();
create function public.mask_my_profile()
returns table(user_id uuid,email text,contact_email text,username text,display_name text,role text,approved boolean,must_change_password boolean,permissions jsonb)
language sql security definer set search_path=public as $$
  select m.user_id,m.email,m.contact_email,m.username,m.display_name,m.role,m.approved,m.must_change_password,r.permissions
  from public.mask_app_members m join public.mask_role_permissions r on r.role=m.role
  where m.user_id=auth.uid();
$$;

create or replace function public.mask_get_role_permissions()
returns table(role text,permissions jsonb)
language sql security definer set search_path=public as $$
  select r.role,r.permissions from public.mask_role_permissions r
  where exists(select 1 from public.mask_app_members m where m.user_id=auth.uid() and m.approved)
  order by case r.role when 'admin' then 1 when 'staff' then 2 else 3 end;
$$;

revoke execute on function public.mask_has_permission(text) from public,anon;
revoke execute on function public.mask_register_current_user() from public,anon;
revoke execute on function public.mask_my_profile() from public,anon;
revoke execute on function public.mask_get_role_permissions() from public,anon;
grant execute on function public.mask_has_permission(text) to authenticated;
grant execute on function public.mask_register_current_user() to authenticated;
grant execute on function public.mask_my_profile() to authenticated;
grant execute on function public.mask_get_role_permissions() to authenticated;

-- 雲端狀態的寫入仍由既有 mask_save_state 處理；禁止僅檢視角色寫入。
create or replace function public.mask_save_state(p_data jsonb,p_expected_version bigint default 0)
returns table(new_version bigint,saved_at timestamptz)
language plpgsql security definer set search_path=public as $$
declare current_version bigint;
begin
  if not public.mask_has_permission('order_edit') then raise exception 'PERMISSION_DENIED'; end if;
  select s.version into current_version from public.mask_app_state s where s.id='main' for update;
  if current_version is null then
    insert into public.mask_app_state(id,data,version,updated_at,updated_by) values('main',p_data,1,now(),auth.uid());
    return query select 1::bigint,now(); return;
  end if;
  if current_version<>p_expected_version then raise exception 'SYNC_CONFLICT'; end if;
  update public.mask_app_state set data=p_data,version=version+1,updated_at=now(),updated_by=auth.uid() where id='main';
  return query select current_version+1,now();
end; $$;

revoke execute on function public.mask_save_state(jsonb,bigint) from public,anon;
grant execute on function public.mask_save_state(jsonb,bigint) to authenticated;
