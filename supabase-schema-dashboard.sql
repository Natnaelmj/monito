-- Sensor dashboard schema. Run this in the SQL Editor after
-- supabase-schema.sql. Every signed-up user gets one demo sensor with
-- ~24h of synthetic readings (including one past excursion, to make the
-- dashboard look like something real) — this is placeholder data for the
-- pre-launch period. When a customer's physical sensor goes in, replace
-- their demo rows with real ones the same way tier upgrades work today:
-- by hand, in the table editor. A real ingestion endpoint (hardware ->
-- readings table) is a later addition, not part of this.

create table public.sensors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

alter table public.sensors enable row level security;

create policy "Users can read own sensors"
  on public.sensors for select
  using (auth.uid() = user_id);

create table public.readings (
  id uuid primary key default gen_random_uuid(),
  sensor_id uuid not null references public.sensors(id) on delete cascade,
  temperature numeric not null,
  recorded_at timestamptz not null default now()
);

alter table public.readings enable row level security;

create policy "Users can read own readings"
  on public.readings for select
  using (exists (
    select 1 from public.sensors s
    where s.id = readings.sensor_id and s.user_id = auth.uid()
  ));

create index readings_sensor_recorded_idx on public.readings (sensor_id, recorded_at desc);

-- Seed one demo sensor + 24h of half-hourly readings for every new signup.
create function public.seed_demo_sensor()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  new_sensor_id uuid;
  i int;
begin
  insert into public.sensors (user_id, name)
  values (new.id, 'Frigo Bar')
  returning id into new_sensor_id;

  for i in 0..47 loop
    insert into public.readings (sensor_id, temperature, recorded_at)
    values (
      new_sensor_id,
      case
        when i between 20 and 22 then round((-11 + (random() * 3))::numeric, 1)
        else round((-19 + (random() * 1.6 - 0.8))::numeric, 1)
      end,
      now() - (i * interval '30 minutes')
    );
  end loop;

  return new;
end;
$$;

create trigger on_auth_user_created_seed_sensor
  after insert on auth.users
  for each row execute function public.seed_demo_sensor();
