-- 口罩訂購助手 v3.3.0
-- 管理員批次更新買家訂單狀態

create or replace function public.mask_admin_bulk_update_buyer_orders(p_order_ids uuid[],p_status text)
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare v_count integer;
begin
  if not public.mask_has_permission('record_apply') then raise exception 'PERMISSION_DENIED'; end if;
  if p_status not in ('pending','confirmed','contact','aggregated','cancelled','completed') then raise exception 'INVALID_STATUS'; end if;
  if coalesce(array_length(p_order_ids,1),0)=0 then return 0; end if;
  update public.mask_buyer_orders
  set status=p_status,reviewed_by=auth.uid(),updated_at=now()
  where id=any(p_order_ids);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.mask_admin_bulk_update_buyer_orders(uuid[],text) from public,anon;
grant execute on function public.mask_admin_bulk_update_buyer_orders(uuid[],text) to authenticated;
