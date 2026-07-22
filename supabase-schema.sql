-- Monito account schema: one profile row per signed-up user.
-- Tier is NOT self-service — it defaults to 'pilot' (no Assistente Frigo
-- access) and is only ever changed by you, manually, in the Supabase table
-- editor, when a customer actually upgrades over WhatsApp. RLS lets a user
-- read their own row but nobody (besides the service role, which bypasses
-- RLS) can write to it.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  tier text not null default 'pilot' check (tier in ('pilot','standard','premium')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can read own profile"
  on public.profiles for select
  using (auth.uid() = id);

-- Auto-create a profile (tier='pilot') whenever someone signs up.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
