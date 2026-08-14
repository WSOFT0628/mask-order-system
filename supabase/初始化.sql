-- 口罩訂購助手 v2.0.0：Supabase 初始化
-- 請在 Supabase Dashboard > SQL Editor 建立 New query，貼上全文後按 Run。

create table if not exists public.mask_app_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'staff' check (role in ('admin','staff','viewer')),
  approved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mask_app_state (
  id text primary key default 'main' check (id = 'main'),
  data jsonb not null default '{}'::jsonb,
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.mask_app_members enable row level security;
alter table public.mask_app_state enable row level security;

create or replace function public.mask_is_approved()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.mask_app_members
    where user_id = auth.uid() and approved = true
  );
$$;

create or replace function public.mask_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.mask_app_members
    where user_id = auth.uid() and approved = true and role = 'admin'
  );
$$;

create or replace function public.mask_register_current_user()
returns table(approved boolean, role text)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  is_first boolean;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select not exists(select 1 from public.mask_app_members) into is_first;

  insert into public.mask_app_members(user_id, email, role, approved)
  values (
    auth.uid(),
    coalesce(auth.jwt() ->> 'email', ''),
    case when is_first then 'admin' else 'staff' end,
    is_first
  )
  on conflict (user_id) do update
    set email = excluded.email, updated_at = now();

  return query
  select m.approved, m.role
  from public.mask_app_members m
  where m.user_id = auth.uid();
end;
$$;

create or replace function public.mask_load_state()
returns table(data jsonb, version bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.mask_is_approved() then
    raise exception 'NOT_APPROVED';
  end if;
  return query
  select s.data, s.version, s.updated_at
  from public.mask_app_state s
  where s.id = 'main';
end;
$$;

create or replace function public.mask_save_state(p_data jsonb, p_expected_version bigint default 0)
returns table(new_version bigint, saved_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_version bigint;
begin
  if not public.mask_is_approved() then
    raise exception 'NOT_APPROVED';
  end if;

  select version into current_version
  from public.mask_app_state
  where id = 'main'
  for update;

  if current_version is null then
    insert into public.mask_app_state(id, data, version, updated_at, updated_by)
    values ('main', p_data, 1, now(), auth.uid());
    return query select 1::bigint, now();
    return;
  end if;

  if p_expected_version <> current_version then
    raise exception 'SYNC_CONFLICT:%', current_version;
  end if;

  update public.mask_app_state
  set data = p_data,
      version = current_version + 1,
      updated_at = now(),
      updated_by = auth.uid()
  where id = 'main';

  return query select current_version + 1, now();
end;
$$;

create or replace function public.mask_list_members()
returns table(user_id uuid, email text, display_name text, role text, approved boolean, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.mask_is_admin() then
    raise exception 'ADMIN_ONLY';
  end if;
  return query
  select m.user_id, m.email, m.display_name, m.role, m.approved, m.created_at
  from public.mask_app_members m
  order by m.created_at;
end;
$$;

create or replace function public.mask_update_member(p_user_id uuid, p_approved boolean, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.mask_is_admin() then
    raise exception 'ADMIN_ONLY';
  end if;
  if p_role not in ('admin','staff','viewer') then
    raise exception 'INVALID_ROLE';
  end if;
  update public.mask_app_members
  set approved = p_approved, role = p_role, updated_at = now()
  where user_id = p_user_id;
end;
$$;

revoke all on public.mask_app_members from anon, authenticated;
revoke all on public.mask_app_state from anon, authenticated;
revoke execute on function public.mask_register_current_user() from public, anon;
revoke execute on function public.mask_load_state() from public, anon;
revoke execute on function public.mask_save_state(jsonb, bigint) from public, anon;
revoke execute on function public.mask_list_members() from public, anon;
revoke execute on function public.mask_update_member(uuid, boolean, text) from public, anon;
grant execute on function public.mask_register_current_user() to authenticated;
grant execute on function public.mask_load_state() to authenticated;
grant execute on function public.mask_save_state(jsonb, bigint) to authenticated;
grant execute on function public.mask_list_members() to authenticated;
grant execute on function public.mask_update_member(uuid, boolean, text) to authenticated;
