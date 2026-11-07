-- ============================================================
-- Mapus / Supabase schema
-- Run once in Supabase Dashboard -> SQL Editor.
--
-- This replaces the Firebase Realtime Database tree:
--   rooms/{room}/details         -> public.rooms
--   rooms/{room}/users/{uid}     -> public.room_users
--   rooms/{room}/objects/{id}    -> public.room_objects
--   objects/{id}/coords/{pushId} -> public.room_objects.coords (jsonb array)
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- Tables
-- ------------------------------------------------------------

create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null default 'New map',
  description text not null default '',
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create table if not exists public.room_users (
  room_id    uuid not null references public.rooms(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text,
  imgsrc     text,
  color      text,
  lat        double precision default 0,
  lng        double precision default 0,
  active     boolean not null default true,
  session    integer not null default 0,
  view_lat   double precision,
  view_lng   double precision,
  zoom       integer,
  updated_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.room_objects (
  id          uuid primary key,
  room_id     uuid not null references public.rooms(id) on delete cascade,
  user_id     uuid not null,
  type        text not null check (type in ('draw', 'line', 'area', 'marker')),
  color       text,
  name        text default '',
  description text default '',
  lat         double precision,
  lng         double precision,
  initlat     double precision,
  initlng     double precision,
  m_type      text,
  place_id    text,
  completed   boolean not null default false,
  path        jsonb,
  coords      jsonb not null default '[]'::jsonb,
  area        double precision,
  distance    double precision,
  session     integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists room_objects_room_idx on public.room_objects (room_id);
create index if not exists room_objects_room_created_idx on public.room_objects (room_id, created_at);
create index if not exists room_users_room_idx on public.room_users (room_id);

-- ------------------------------------------------------------
-- updated_at maintenance
-- ------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists room_objects_touch on public.room_objects;
create trigger room_objects_touch
  before update on public.room_objects
  for each row execute function public.touch_updated_at();

drop trigger if exists room_users_touch on public.room_users;
create trigger room_users_touch
  before update on public.room_users
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- RPC: join_room
-- Upserts the caller's presence row and bumps the per-visit session
-- counter, returning the new session (the old ServerValue.increment).
-- SECURITY DEFINER so the row can be created on first visit; user_id
-- is always taken from auth.uid(), never from the client.
-- ------------------------------------------------------------

create or replace function public.join_room(
  p_room_id  uuid,
  p_name     text,
  p_imgsrc   text,
  p_color    text,
  p_view_lat double precision,
  p_view_lng double precision,
  p_zoom     integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_session integer;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  insert into public.room_users as ru
    (room_id, user_id, name, imgsrc, color, lat, lng, active, session, view_lat, view_lng, zoom)
  values
    (p_room_id, v_uid, p_name, p_imgsrc, p_color, 0, 0, true, 1,
     p_view_lat, p_view_lng, p_zoom)
  on conflict (room_id, user_id) do update
    set name       = coalesce(excluded.name, ru.name),
        imgsrc     = coalesce(excluded.imgsrc, ru.imgsrc),
        color      = coalesce(excluded.color, ru.color),
        active     = true,
        session    = ru.session + 1,
        view_lat   = excluded.view_lat,
        view_lng   = excluded.view_lng,
        zoom       = excluded.zoom,
        updated_at = now()
  returning ru.session into v_session;

  return v_session;
end;
$$;

revoke all on function public.join_room(uuid, text, text, text, double precision, double precision, integer) from public;
grant execute on function public.join_room(uuid, text, text, text, double precision, double precision, integer) to authenticated;

-- ------------------------------------------------------------
-- RPC: append_coords
-- Appends a batch of vertices to a shape while it is being drawn.
-- Doing it in SQL keeps concurrent appends atomic (no read-modify-write
-- race) and lets the client batch ~8 points per request.
-- RLS applies: only the shape owner may append.
-- ------------------------------------------------------------

create or replace function public.append_coords(
  p_object_id uuid,
  p_coords    jsonb
)
returns void
language sql
security invoker
as $$
  update public.room_objects
     set coords = coords || coalesce(p_coords, '[]'::jsonb)
   where id = p_object_id;
$$;

revoke all on function public.append_coords(uuid, jsonb) from public;
grant execute on function public.append_coords(uuid, jsonb) to authenticated;

-- Clean up the previous single-point signature if this file is re-run
drop function if exists public.append_coord(uuid, double precision, double precision);

-- ------------------------------------------------------------
-- Row Level Security
-- Signed-in users can open any room by link (same as Mapus' default
-- Firebase rules). Shapes are only editable by their author, but any
-- participant may erase them (that is what the eraser tool does).
-- ------------------------------------------------------------

alter table public.rooms        enable row level security;
alter table public.room_users   enable row level security;
alter table public.room_objects enable row level security;

drop policy if exists rooms_select on public.rooms;
create policy rooms_select on public.rooms
  for select to authenticated using (true);

drop policy if exists rooms_insert on public.rooms;
create policy rooms_insert on public.rooms
  for insert to authenticated with check (true);

drop policy if exists rooms_update on public.rooms;
create policy rooms_update on public.rooms
  for update to authenticated using (true) with check (true);

drop policy if exists room_users_select on public.room_users;
create policy room_users_select on public.room_users
  for select to authenticated using (true);

drop policy if exists room_users_insert on public.room_users;
create policy room_users_insert on public.room_users
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists room_users_update on public.room_users;
create policy room_users_update on public.room_users
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists room_objects_select on public.room_objects;
create policy room_objects_select on public.room_objects
  for select to authenticated using (true);

drop policy if exists room_objects_insert on public.room_objects;
create policy room_objects_insert on public.room_objects
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists room_objects_update on public.room_objects;
create policy room_objects_update on public.room_objects
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists room_objects_delete on public.room_objects;
create policy room_objects_delete on public.room_objects
  for delete to authenticated using (true);

-- ------------------------------------------------------------
-- Realtime
-- REPLICA IDENTITY FULL is required so DELETE events carry the whole
-- old row, which is what makes room_id=eq.<id> filters work on deletes.
-- ------------------------------------------------------------

alter table public.rooms        replica identity full;
alter table public.room_users   replica identity full;
alter table public.room_objects replica identity full;

do $$
begin
  -- Realtime is on by default in Supabase, but make sure the publication exists
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;

-- Adding tables is a no-op if they are already part of the publication
-- (and unnecessary when the publication covers all tables)
do $$
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime' and puballtables
  ) then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms'
    ) then
      alter publication supabase_realtime add table public.rooms;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_users'
    ) then
      alter publication supabase_realtime add table public.room_users;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_objects'
    ) then
      alter publication supabase_realtime add table public.room_objects;
    end if;
  end if;
end;
$$;
