-- Bean & Brew database setup
-- Paste this whole file into Supabase -> SQL Editor -> New query -> Run.
-- It is safe to run more than once.

create table if not exists menu_items (
    id          bigint generated always as identity primary key,
    name        text not null,
    name_lower  text generated always as (lower(name)) stored,
    price       numeric not null check (price >= 0),
    category    text not null default 'other',
    image       text not null default '',
    description text not null default '',
    created_at  timestamptz not null default now(),
    constraint menu_items_name_lower_key unique (name_lower)
);

create table if not exists orders (
    id             bigint generated always as identity primary key,
    order_number   text not null unique,
    created_at     timestamptz not null default now(),
    customer_name  text not null,
    customer_phone text not null,
    order_type     text not null check (order_type in ('Pickup', 'Delivery')),
    note           text not null default '',
    items          jsonb not null,
    total          numeric not null
);

-- Lock both tables so nobody can read or change them from the browser.
-- Only your backend (which uses the secret key) can access them.
alter table menu_items enable row level security;
alter table orders     enable row level security;