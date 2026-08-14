-- 口罩訂購助手 v2.2.2：通知中心與帳號別名升級
-- 請先完成 v2.2.0，再於 Supabase SQL Editor 執行本檔一次。

create table if not exists public.mask_notifications (
  id uuid primary key default gen_random_uuid(),
  event_key text unique,
  level text not null default 'info' check(level in ('info','warn','danger')),
  title text not null,
  body text not null default '',
  link text,
  audience_role text check(audience_role is null or audience_role in ('admin','staff','viewer')),
  target_user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.mask_notification_reads (
  notification_id uuid references public.mask_notifications(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  dismissed_at timestamptz,
  primary key(notification_id,user_id)
);
alter table public.mask_notification_reads add column if not exists dismissed_at timestamptz;

alter table public.mask_notifications enable row level security;
alter table public.mask_notification_reads enable row level security;
revoke all on public.mask_notifications from anon,authenticated;
revoke all on public.mask_notification_reads from anon,authenticated;

create or replace function public.mask_list_notifications()
returns table(id uuid,event_key text,level text,title text,body text,link text,created_at timestamptz,is_read boolean)
language sql security definer set search_path=public as $$
  select n.id,n.event_key,n.level,n.title,n.body,n.link,n.created_at,(r.user_id is not null)
  from public.mask_notifications n
  join public.mask_app_members m on m.user_id=auth.uid() and m.approved
  left join public.mask_notification_reads r on r.notification_id=n.id and r.user_id=auth.uid()
  where (n.target_user_id is null or n.target_user_id=auth.uid())
    and (n.audience_role is null or n.audience_role=m.role)
    and r.dismissed_at is null
  order by n.created_at desc limit 60;
$$;

create or replace function public.mask_mark_notifications_read()
returns void language sql security definer set search_path=public as $$
  insert into public.mask_notification_reads(notification_id,user_id)
  select n.id,auth.uid() from public.mask_notifications n
  join public.mask_app_members m on m.user_id=auth.uid() and m.approved
  where (n.target_user_id is null or n.target_user_id=auth.uid())
    and (n.audience_role is null or n.audience_role=m.role)
  on conflict(notification_id,user_id) do update set read_at=now(),dismissed_at=null;
$$;

create or replace function public.mask_clear_read_notifications()
returns void language sql security definer set search_path=public as $$
  update public.mask_notification_reads set dismissed_at=now() where user_id=auth.uid();
$$;

create or replace function public.mask_create_notification(
  p_event_key text,p_level text,p_title text,p_body text default '',p_link text default null,
  p_audience_role text default null,p_target_user_id uuid default null
) returns void language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if p_target_user_id is distinct from auth.uid() and not public.mask_has_permission('settings_manage') then
    raise exception 'PERMISSION_DENIED';
  end if;
  insert into public.mask_notifications(event_key,level,title,body,link,audience_role,target_user_id)
  values(p_event_key,case when p_level in('info','warn','danger') then p_level else 'info' end,p_title,p_body,p_link,p_audience_role,p_target_user_id)
  on conflict(event_key) do update set level=excluded.level,title=excluded.title,body=excluded.body,link=excluded.link,created_at=now();
end; $$;

revoke execute on function public.mask_list_notifications() from public,anon;
revoke execute on function public.mask_mark_notifications_read() from public,anon;
revoke execute on function public.mask_clear_read_notifications() from public,anon;
revoke execute on function public.mask_create_notification(text,text,text,text,text,text,uuid) from public,anon;
grant execute on function public.mask_list_notifications() to authenticated;
grant execute on function public.mask_mark_notifications_read() to authenticated;
grant execute on function public.mask_clear_read_notifications() to authenticated;
grant execute on function public.mask_create_notification(text,text,text,text,text,text,uuid) to authenticated;
