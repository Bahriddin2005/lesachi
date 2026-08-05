-- Shared Lesachi data model.  The app deliberately uses text IDs so the
-- records can also be migrated from the original SQLite database later.
create table if not exists public.customers (
  id text primary key,
  full_name text not null,
  phone text not null unique,
  created_at timestamptz not null
);

create table if not exists public.equipment_types (
  id text primary key,
  name text not null unique,
  daily_price integer not null default 0,
  total_quantity integer not null default 0
);

create table if not exists public.rentals (
  id text primary key,
  customer_id text not null references public.customers(id),
  started_at timestamptz not null,
  status text not null default 'active',
  closed_at timestamptz
);

create table if not exists public.rental_items (
  id text primary key,
  rental_id text not null references public.rentals(id) on delete cascade,
  equipment_type_id text references public.equipment_types(id),
  name text not null,
  quantity integer not null,
  daily_price integer not null,
  started_at timestamptz not null,
  status text not null default 'open',
  returned_at timestamptz,
  frozen_amount integer
);

create table if not exists public.item_returns (
  id text primary key,
  rental_item_id text not null references public.rental_items(id) on delete cascade,
  quantity integer not null,
  returned_at timestamptz not null
);

create table if not exists public.sent_messages (
  id text primary key,
  rental_id text not null references public.rentals(id) on delete cascade,
  channel text not null,
  message text not null,
  status text not null,
  created_at timestamptz not null
);

create table if not exists public.settings (
  key text primary key,
  value text not null
);

create index if not exists rental_items_rental_status_idx
  on public.rental_items (rental_id, status);
create index if not exists rental_items_equipment_status_idx
  on public.rental_items (equipment_type_id, status);

-- This app is intentionally a shared, no-login workspace: every signed-out
-- user can read and write the same company records.  The public anon key is
-- safe in the browser; no service-role key is shipped to the client.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'customers', 'equipment_types', 'rentals', 'rental_items',
    'item_returns', 'sent_messages', 'settings'
  ] loop
    execute format('grant select, insert, update, delete on table public.%I to anon, authenticated', table_name);
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists lesachi_public_all on public.%I', table_name);
    execute format(
      'create policy lesachi_public_all on public.%I for all to anon, authenticated using (true) with check (true)',
      table_name
    );
  end loop;
end $$;

-- Partial returns must be atomic.  The browser invokes this function through
-- Supabase RPC, while row locks prevent two users from returning the same
-- stock at the same time.
create or replace function public.register_rental_return(
  p_rental_id text,
  p_requests jsonb,
  p_returned_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  request jsonb;
  source_item public.rental_items%rowtype;
  item_id text;
  requested_quantity integer;
  remaining_quantity integer;
  started_at_value timestamptz;
  frozen_amount_value integer;
  returned_rows jsonb := '[]'::jsonb;
  remaining_rows jsonb := '[]'::jsonb;
  is_closed boolean;
  generated_item_id text;
begin
  if jsonb_typeof(p_requests) <> 'array' or jsonb_array_length(p_requests) = 0 then
    raise exception 'Qaytariladigan anjom tanlanmagan.';
  end if;

  if not exists (select 1 from public.rentals where id = p_rental_id) then
    raise exception 'Ijara topilmadi.';
  end if;

  for request in select * from jsonb_array_elements(p_requests) loop
    item_id := nullif(trim(request->>'itemId'), '');
    requested_quantity := (request->>'quantity')::integer;
    if item_id is null or requested_quantity is null or requested_quantity <= 0 then
      raise exception 'Qaytarilgan sonini to‘g‘ri kiriting.';
    end if;

    select * into source_item
    from public.rental_items
    where id = item_id and rental_id = p_rental_id
    for update;

    if not found or source_item.status <> 'open' or source_item.quantity <= 0 then
      raise exception 'Anjom allaqachon qaytarilgan yoki topilmadi.';
    end if;
    if requested_quantity > source_item.quantity then
      raise exception '%: mijozdagi % donadan ko‘p qaytarib bo‘lmaydi.', source_item.name, source_item.quantity;
    end if;

    started_at_value := source_item.started_at;
    frozen_amount_value := greatest(1, (p_returned_at::date - started_at_value::date) + 1)
      * source_item.daily_price * requested_quantity;
    remaining_quantity := source_item.quantity - requested_quantity;

    update public.rental_items
    set quantity = requested_quantity,
        status = 'returned',
        returned_at = p_returned_at,
        frozen_amount = frozen_amount_value
    where id = source_item.id;

    insert into public.item_returns (id, rental_item_id, quantity, returned_at)
    values (
      'return_' || substr(md5(random()::text || clock_timestamp()::text), 1, 24),
      source_item.id,
      requested_quantity,
      p_returned_at
    );

    returned_rows := returned_rows || jsonb_build_array(jsonb_build_object(
      'id', source_item.id,
      'rentalId', source_item.rental_id,
      'equipmentTypeId', source_item.equipment_type_id,
      'name', source_item.name,
      'quantity', requested_quantity,
      'dailyPrice', source_item.daily_price,
      'startedAt', started_at_value,
      'status', 'returned',
      'returnedAt', p_returned_at,
      'frozenAmount', frozen_amount_value
    ));

    if remaining_quantity > 0 then
      generated_item_id := 'item_' || substr(md5(random()::text || clock_timestamp()::text), 1, 24);
      insert into public.rental_items (
        id, rental_id, equipment_type_id, name, quantity, daily_price,
        started_at, status, returned_at, frozen_amount
      ) values (
        generated_item_id,
        source_item.rental_id,
        source_item.equipment_type_id,
        source_item.name,
        remaining_quantity,
        source_item.daily_price,
        started_at_value,
        'open',
        null,
        null
      );
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ri.id,
    'rentalId', ri.rental_id,
    'equipmentTypeId', ri.equipment_type_id,
    'name', ri.name,
    'quantity', ri.quantity,
    'dailyPrice', ri.daily_price,
    'startedAt', ri.started_at,
    'status', ri.status,
    'returnedAt', ri.returned_at,
    'frozenAmount', ri.frozen_amount
  ) order by ri.id), '[]'::jsonb)
  into remaining_rows
  from public.rental_items ri
  where ri.rental_id = p_rental_id and ri.status = 'open' and ri.quantity > 0;

  is_closed := jsonb_array_length(remaining_rows) = 0;
  update public.rentals
  set status = case when is_closed then 'closed' else 'active' end,
      closed_at = case when is_closed then p_returned_at else null end
  where id = p_rental_id;

  return jsonb_build_object(
    'rentalId', p_rental_id,
    'returnedAt', p_returned_at,
    'returnedRows', returned_rows,
    'remainingRows', remaining_rows,
    'wasClosed', is_closed
  );
end;
$$;

grant execute on function public.register_rental_return(text, jsonb, timestamptz)
  to anon, authenticated;

-- Unified customer edit: return existing items and add newly borrowed items
-- in one database transaction. The return RPC above performs the row split;
-- additions are validated against current stock after those returned pieces
-- have been released.
create or replace function public.edit_rental_with_changes(
  p_rental_id text,
  p_returns jsonb default '[]'::jsonb,
  p_items jsonb default '[]'::jsonb,
  p_changed_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  return_result jsonb := jsonb_build_object(
    'returnedRows', '[]'::jsonb,
    'remainingRows', '[]'::jsonb,
    'wasClosed', false,
    'returnedAt', p_changed_at
  );
  item jsonb;
  equipment_row public.equipment_types%rowtype;
  rented_quantity integer;
  available_quantity integer;
  item_id text;
  added_rows jsonb := '[]'::jsonb;
  remaining_rows jsonb := '[]'::jsonb;
  has_open_items boolean;
begin
  if not exists (select 1 from public.rentals where id = p_rental_id) then
    raise exception 'Ijara topilmadi.';
  end if;
  if jsonb_typeof(coalesce(p_returns, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
    raise exception 'O‘zgarishlar formati noto‘g‘ri.';
  end if;
  if jsonb_array_length(coalesce(p_returns, '[]'::jsonb)) = 0
     and jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'Hech qanday o‘zgarish kiritilmadi.';
  end if;

  -- This call locks and splits every returned row. Since it is inside this
  -- function, additions below commit or roll back with the returns.
  if jsonb_array_length(coalesce(p_returns, '[]'::jsonb)) > 0 then
    return_result := public.register_rental_return(p_rental_id, p_returns, p_changed_at);
  end if;

  for item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if nullif(trim(item->>'equipmentTypeId'), '') is null then
      raise exception 'Qo‘shiladigan anjom turini tanlang.';
    end if;
    if (item->>'quantity') is null or (item->>'quantity')::integer <= 0 then
      raise exception 'Qo‘shiladigan anjom sonini to‘g‘ri kiriting.';
    end if;

    select * into equipment_row
    from public.equipment_types
    where id = item->>'equipmentTypeId'
    for update;
    if not found then
      raise exception 'Qo‘shiladigan anjom omborda topilmadi.';
    end if;

    select coalesce(sum(ri.quantity), 0)::integer into rented_quantity
    from public.rental_items ri
    join public.rentals r on r.id = ri.rental_id
    where ri.equipment_type_id = equipment_row.id
      and ri.status = 'open'
      and ri.quantity > 0
      and r.status <> 'closed';
    available_quantity := equipment_row.total_quantity - rented_quantity;
    if (item->>'quantity')::integer > greatest(0, available_quantity) then
      raise exception '%: omborda faqat % dona mavjud.', equipment_row.name, greatest(0, available_quantity);
    end if;

    item_id := coalesce(nullif(trim(item->>'id'), ''), 'item_' || substr(md5(random()::text || clock_timestamp()::text), 1, 24));
    insert into public.rental_items (
      id, rental_id, equipment_type_id, name, quantity, daily_price,
      started_at, status, returned_at, frozen_amount
    ) values (
      item_id,
      p_rental_id,
      equipment_row.id,
      equipment_row.name,
      (item->>'quantity')::integer,
      equipment_row.daily_price,
      p_changed_at,
      'open',
      null,
      null
    );

    added_rows := added_rows || jsonb_build_array(jsonb_build_object(
      'id', item_id,
      'rentalId', p_rental_id,
      'equipmentTypeId', equipment_row.id,
      'name', equipment_row.name,
      'quantity', (item->>'quantity')::integer,
      'dailyPrice', equipment_row.daily_price,
      'startedAt', p_changed_at,
      'status', 'open',
      'returnedAt', null,
      'frozenAmount', null
    ));
  end loop;

  select exists(
    select 1 from public.rental_items
    where rental_id = p_rental_id and status = 'open' and quantity > 0
  ) into has_open_items;
  update public.rentals
  set status = case when has_open_items then 'active' else 'closed' end,
      closed_at = case when has_open_items then null else p_changed_at end
  where id = p_rental_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ri.id,
    'rentalId', ri.rental_id,
    'equipmentTypeId', ri.equipment_type_id,
    'name', ri.name,
    'quantity', ri.quantity,
    'dailyPrice', ri.daily_price,
    'startedAt', ri.started_at,
    'status', ri.status,
    'returnedAt', ri.returned_at,
    'frozenAmount', ri.frozen_amount
  ) order by ri.id), '[]'::jsonb)
  into remaining_rows
  from public.rental_items ri
  where ri.rental_id = p_rental_id and ri.status = 'open' and ri.quantity > 0;

  return jsonb_build_object(
    'rentalId', p_rental_id,
    'changedAt', p_changed_at,
    'returnedAt', return_result->'returnedAt',
    'returnedRows', coalesce(return_result->'returnedRows', '[]'::jsonb),
    'addedRows', added_rows,
    'remainingRows', remaining_rows,
    'wasClosed', not has_open_items
  );
end;
$$;

grant execute on function public.edit_rental_with_changes(text, jsonb, jsonb, timestamptz)
  to anon, authenticated;

create or replace function public.create_rental_with_items(
  p_rental_id text,
  p_customer_id text,
  p_customer_name text,
  p_phone text,
  p_items jsonb,
  p_started_at timestamptz default now()
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  customer_id_value text;
  equipment_id_value text;
begin
  if nullif(trim(p_customer_name), '') is null or nullif(trim(p_phone), '') is null then
    raise exception 'Mijoz ma’lumotlarini to‘liq kiriting.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Kamida bitta anjom tanlang.';
  end if;

  insert into public.customers (id, full_name, phone, created_at)
  values (p_customer_id, trim(p_customer_name), trim(p_phone), p_started_at)
  on conflict (phone) do update set full_name = excluded.full_name
  returning id into customer_id_value;

  insert into public.rentals (id, customer_id, started_at, status)
  values (p_rental_id, customer_id_value, p_started_at, 'active');

  for item in select * from jsonb_array_elements(p_items) loop
    insert into public.equipment_types (id, name, daily_price, total_quantity)
    values (
      item->>'equipmentTypeId',
      trim(item->>'name'),
      (item->>'dailyPrice')::integer,
      0
    )
    on conflict (name) do update set daily_price = excluded.daily_price
    returning id into equipment_id_value;

    insert into public.rental_items (
      id, rental_id, equipment_type_id, name, quantity, daily_price,
      started_at, status, returned_at, frozen_amount
    ) values (
      item->>'id',
      p_rental_id,
      equipment_id_value,
      trim(item->>'name'),
      (item->>'quantity')::integer,
      (item->>'dailyPrice')::integer,
      p_started_at,
      'open',
      null,
      null
    );
  end loop;

  return p_rental_id;
end;
$$;

grant execute on function public.create_rental_with_items(text, text, text, text, jsonb, timestamptz)
  to anon, authenticated;

insert into public.equipment_types (id, name, daily_price, total_quantity)
values
  ('eq_lesa', 'Lesa komplekti', 25000, 0),
  ('eq_taxta', 'Taxta', 5000, 0),
  ('eq_opalubka', 'Opalubka', 30000, 0),
  ('eq_teleskopik', 'Teleskopik tirgak', 8000, 0)
on conflict (name) do nothing;

insert into public.settings (key, value)
values ('message_channel', 'Telegram')
on conflict (key) do nothing;
