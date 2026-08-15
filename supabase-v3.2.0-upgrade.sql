-- 口罩訂購助手 v3.2.0
-- 1. 修復歷史訂單彙總金額 2. 管理員單筆／批次永久刪除買家訂單

with recalculated as (
  select o.id,
    coalesce(sum((line->>'qty')::integer),0)::integer as total_qty,
    coalesce(sum((line->>'line_total')::numeric),0)::numeric(12,2) as subtotal
  from public.mask_buyer_orders o
  left join lateral jsonb_array_elements(o.items) line on true
  group by o.id
)
update public.mask_buyer_orders o
set total_qty=r.total_qty,
    subtotal=r.subtotal,
    total=(r.subtotal + o.shipping + o.tax)::numeric(12,2),
    updated_at=now()
from recalculated r
where o.id=r.id
  and (o.total_qty is distinct from r.total_qty
    or o.subtotal is distinct from r.subtotal
    or o.total is distinct from (r.subtotal + o.shipping + o.tax)::numeric(12,2));

create or replace function public.mask_admin_delete_buyer_orders(p_order_ids uuid[])
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare v_count integer;
begin
  if not public.mask_has_permission('record_delete') then
    raise exception 'PERMISSION_DENIED';
  end if;
  if coalesce(array_length(p_order_ids,1),0)=0 then return 0; end if;
  delete from public.mask_buyer_orders where id=any(p_order_ids);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.mask_admin_delete_buyer_orders(uuid[]) from public,anon;
grant execute on function public.mask_admin_delete_buyer_orders(uuid[]) to authenticated;
