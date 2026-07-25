-- Competitor Price Monitoring — full schema (already applied to project tepyapssrofxuwonqepv).
-- Kept here so the database is reproducible from source.

create schema if not exists price_monitor;

create or replace function price_monitor.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create table if not exists price_monitor.tracked_products (
  id                uuid primary key default gen_random_uuid(),
  source_product_id uuid references public.products(id) on delete set null,
  external_ref      text,
  model_code        text not null unique,
  name              text,
  brand             text default 'Bosch',
  category          text,
  our_price         numeric(12,2),
  threshold_price   numeric(12,2),
  wholesale_price   numeric(12,2),
  retail_price      numeric(12,2),
  in_stock          boolean default true,
  quantity          integer,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists price_monitor.competitors (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                text not null unique,
  type                text not null default 'retailer' check (type in ('retailer','manufacturer')),
  website_url         text,
  fetch_method        text not null default 'jsonld' check (fetch_method in ('jsonld','selector','api')),
  search_url_template text,
  config              jsonb not null default '{}'::jsonb,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table if not exists price_monitor.competitor_products (
  id                 uuid primary key default gen_random_uuid(),
  tracked_product_id uuid not null references price_monitor.tracked_products(id) on delete cascade,
  competitor_id      uuid not null references price_monitor.competitors(id) on delete cascade,
  product_url        text,
  competitor_sku     text,
  match_status       text not null default 'not_found'
                       check (match_status in ('auto_found','confirmed','not_found','rejected')),
  match_confidence   numeric(4,3),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tracked_product_id, competitor_id)
);

create table if not exists price_monitor.price_snapshots (
  id                    uuid primary key default gen_random_uuid(),
  competitor_product_id uuid not null references price_monitor.competitor_products(id) on delete cascade,
  price                 numeric(12,2),
  currency              text not null default 'EGP',
  in_stock              boolean,
  below_threshold       boolean,
  fetch_status          text not null default 'ok' check (fetch_status in ('ok','not_found','error','blocked')),
  raw                   jsonb,
  captured_at           timestamptz not null default now()
);

create trigger trg_tracked_products_updated before update on price_monitor.tracked_products
  for each row execute function price_monitor.set_updated_at();
create trigger trg_competitors_updated before update on price_monitor.competitors
  for each row execute function price_monitor.set_updated_at();
create trigger trg_competitor_products_updated before update on price_monitor.competitor_products
  for each row execute function price_monitor.set_updated_at();

create index if not exists idx_cp_tracked    on price_monitor.competitor_products(tracked_product_id);
create index if not exists idx_cp_competitor on price_monitor.competitor_products(competitor_id);
create index if not exists idx_snap_cp_time  on price_monitor.price_snapshots(competitor_product_id, captured_at desc);
create index if not exists idx_snap_time     on price_monitor.price_snapshots(captured_at desc);

-- RLS: internal-only data. No permissive policies; access is via a direct
-- server connection (superuser), never the anon/authenticated REST roles.
alter table price_monitor.tracked_products   enable row level security;
alter table price_monitor.competitors         enable row level security;
alter table price_monitor.competitor_products enable row level security;
alter table price_monitor.price_snapshots     enable row level security;

-- Dashboard views
create or replace view price_monitor.v_latest_competitor_price as
select distinct on (s.competitor_product_id)
  s.competitor_product_id, s.price, s.currency, s.in_stock,
  s.below_threshold, s.fetch_status, s.captured_at
from price_monitor.price_snapshots s
order by s.competitor_product_id, s.captured_at desc;

create or replace view price_monitor.v_comparison as
select
  tp.id as product_id, tp.model_code, tp.name, tp.our_price, tp.threshold_price,
  tp.in_stock as our_in_stock,
  c.id as competitor_id, c.name as competitor_name, c.slug as competitor_slug, c.type as competitor_type,
  cp.id as competitor_product_id, cp.product_url, cp.match_status,
  lp.price as competitor_price, lp.in_stock as competitor_in_stock, lp.below_threshold,
  lp.fetch_status, lp.captured_at,
  case when lp.price is null or tp.our_price is null then null
       else round(((lp.price - tp.our_price) / nullif(tp.our_price,0)) * 100, 1) end as delta_pct
from price_monitor.tracked_products tp
cross join price_monitor.competitors c
left join price_monitor.competitor_products cp
  on cp.tracked_product_id = tp.id and cp.competitor_id = c.id
left join price_monitor.v_latest_competitor_price lp
  on lp.competitor_product_id = cp.id
where tp.is_active and c.is_active;
