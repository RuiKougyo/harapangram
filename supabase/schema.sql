-- 腹ぱんぐらむ: Supabase schema + Row Level Security
-- Supabase の「SQL Editor」にこのファイルを丸ごと貼って Run してください。何回実行しても大丈夫です。
-- ログインは「ID＋パスワード」。Supabase Auth には ID を <id>@harapangram.invalid（実在しない予約ドメイン）として登録し、メールは一切送りません。
--
-- 守っていること
--  * 投稿・写真・いいね/コメントは「本人」と「相互フォローの人」しか読めない（サーバー側で強制）
--  * 書き込みは自分のデータだけ
--  * フォロー関係は、自分が関わる矢印（自分→相手 / 相手→自分）しか見えない
--  * ブロック・承認待ちの管理、行きたいリスト、通知の既読は本人だけ
--  * ニックネームは早い者勝ちで重複不可

-- ---------- tables ----------
create table if not exists public.profiles(
  id uuid primary key references auth.users on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  constraint profiles_size check (pg_column_size(data) < 120000)
);

create table if not exists public.follow_edges(
  src uuid not null references auth.users on delete cascade,
  dst uuid not null references auth.users on delete cascade,
  since bigint not null default 0,
  primary key (src, dst),
  constraint follow_not_self check (src <> dst)
);
create index if not exists follow_edges_dst on public.follow_edges(dst);

-- blocked / declined / invAccepted lists (private to the owner)
create table if not exists public.follow_meta(
  owner uuid primary key references auth.users on delete cascade,
  data jsonb not null default '{}',
  constraint follow_meta_size check (pg_column_size(data) < 60000)
);

create table if not exists public.posts(
  author uuid not null references auth.users on delete cascade,
  id text not null,
  created_at bigint not null default 0,
  data jsonb not null,
  primary key (author, id),
  constraint posts_id check (id ~ '^[A-Za-z0-9_-]{1,40}$'),
  constraint posts_size check (pg_column_size(data) < 20000),
  -- photos must live in Storage, not inline
  constraint posts_no_inline_img check (position('data:image' in data::text) = 0)
);
-- up to 3 photos per post: the cover + 2 more
alter table public.posts drop constraint if exists posts_pics;
alter table public.posts add constraint posts_pics check (coalesce(data->>'pics', '0') ~ '^[0-2]$');
create unique index if not exists profiles_invite_code on public.profiles ((data->>'inviteCode')) where data ? 'inviteCode';
create index if not exists posts_author_created on public.posts(author, created_at desc);

create or replace function public.try_uuid(t text) returns uuid
language sql immutable as $$
  select case when t ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then t::uuid end
$$;

-- likes and comments; "to" = the post's author
create table if not exists public.reacts(
  author uuid not null references auth.users on delete cascade,
  id text not null,
  at bigint not null default 0,
  data jsonb not null,
  to_uid uuid generated always as (public.try_uuid(data->>'to')) stored,
  primary key (author, id),
  constraint reacts_id check (id ~ '^[A-Za-z0-9_-]{1,120}$'),
  constraint reacts_size check (pg_column_size(data) < 4000)
);
create index if not exists reacts_author_at on public.reacts(author, at desc);

-- private per-person data: want-to-go list, notification seen time
create table if not exists public.user_data(
  owner uuid not null references auth.users on delete cascade,
  id text not null,
  data jsonb not null,
  primary key (owner, id),
  constraint user_data_size check (pg_column_size(data) < 8000)
);

-- nickname claims (key = normalized nickname)
create table if not exists public.names(
  key text primary key,
  owner uuid not null references auth.users on delete cascade,
  at bigint not null default 0,
  constraint names_key check (length(key) < 200)
);

-- ---------- helpers ----------
-- true when a and b follow each other
create or replace function public.is_mutual(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a is not null and b is not null
     and exists(select 1 from public.follow_edges where src = a and dst = b)
     and exists(select 1 from public.follow_edges where src = b and dst = a)
$$;

-- can the signed-in user see things owned by u?
create or replace function public.can_see(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select u = auth.uid() or public.is_mutual(u, auth.uid())
$$;

-- did u block the signed-in user?
create or replace function public.blocked_by(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.follow_meta m
                where m.owner = u and (m.data->'blocked') ? auth.uid()::text)
$$;

grant execute on function public.try_uuid(text) to authenticated;
-- may the signed-in user see u's profile? self, anyone with a follow arrow either way, or a mutual of a mutual
create or replace function public.is_connected(u uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select u = auth.uid()
    or exists(select 1 from public.follow_edges where (src = u and dst = auth.uid()) or (src = auth.uid() and dst = u))
    or exists(select 1 from public.follow_edges e1 join public.follow_edges e2 on e2.src = e1.dst and e2.dst = e1.src
              where e1.src = auth.uid() and public.is_mutual(e1.dst, u))
$$;
revoke all on function public.is_connected(uuid) from public, anon;
grant execute on function public.is_connected(uuid) to authenticated;
revoke all on function public.is_mutual(uuid, uuid) from public, anon;
revoke all on function public.can_see(uuid) from public, anon;
revoke all on function public.blocked_by(uuid) from public, anon;
grant execute on function public.is_mutual(uuid, uuid) to authenticated;
grant execute on function public.can_see(uuid) to authenticated;
grant execute on function public.blocked_by(uuid) to authenticated;

-- the public @ID shown to friends always comes from the login ID (never from what the page sends)
create or replace function public.profiles_set_handle() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.data := jsonb_set(coalesce(new.data, '{}'::jsonb), '{handle}',
    to_jsonb(coalesce((select split_part(u.email, '@', 1) from auth.users u where u.id = new.id), '')));
  return new;
end $$;
drop trigger if exists profiles_handle on public.profiles;
create trigger profiles_handle before insert or update on public.profiles
  for each row execute function public.profiles_set_handle();

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.follow_edges enable row level security;
alter table public.follow_meta enable row level security;
alter table public.posts enable row level security;
alter table public.reacts enable row level security;
alter table public.user_data enable row level security;
alter table public.names enable row level security;

-- nothing for signed-out visitors
revoke all on public.profiles, public.follow_edges, public.follow_meta, public.posts,
  public.reacts, public.user_data, public.names from anon;
grant select, insert, update, delete on public.profiles, public.follow_edges, public.follow_meta,
  public.posts, public.reacts, public.user_data, public.names to authenticated;

do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
    and tablename in ('profiles','follow_edges','follow_meta','posts','reacts','user_data','names') loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- profiles: only people you are connected to; strangers are found one at a time by exact @ID or invite code (find_user / find_by_invite)
create policy profiles_read on public.profiles for select to authenticated using (public.is_connected(id));
create policy profiles_ins on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_upd on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_del on public.profiles for delete to authenticated using (id = auth.uid());

-- follow edges: see only arrows that touch you; draw only your own; not toward someone who blocked you
create policy edges_read on public.follow_edges for select to authenticated using (src = auth.uid() or dst = auth.uid());
create policy edges_ins on public.follow_edges for insert to authenticated with check (src = auth.uid() and not public.blocked_by(dst));
create policy edges_upd on public.follow_edges for update to authenticated using (src = auth.uid()) with check (src = auth.uid() and not public.blocked_by(dst));
create policy edges_del on public.follow_edges for delete to authenticated using (src = auth.uid());

create policy meta_all on public.follow_meta for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

-- posts: yourself + mutual followers
create policy posts_read on public.posts for select to authenticated using (public.can_see(author));
create policy posts_ins on public.posts for insert to authenticated with check (author = auth.uid());
create policy posts_upd on public.posts for update to authenticated using (author = auth.uid()) with check (author = auth.uid());
create policy posts_del on public.posts for delete to authenticated using (author = auth.uid());

-- reacts: visible when you can see both the reactor and the post's author; react only on posts you can see
create policy reacts_read on public.reacts for select to authenticated
  using (author = auth.uid() or (public.can_see(author) and (to_uid is null or public.can_see(to_uid))));
create policy reacts_ins on public.reacts for insert to authenticated
  with check (author = auth.uid() and to_uid is not null and public.can_see(to_uid));
create policy reacts_upd on public.reacts for update to authenticated
  using (author = auth.uid()) with check (author = auth.uid() and to_uid is not null and public.can_see(to_uid));
create policy reacts_del on public.reacts for delete to authenticated using (author = auth.uid());

create policy user_data_all on public.user_data for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

create policy names_read on public.names for select to authenticated using (true);
create policy names_ins on public.names for insert to authenticated with check (owner = auth.uid());
create policy names_upd on public.names for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy names_del on public.names for delete to authenticated using (owner = auth.uid());

-- ---------- Storage (photos) ----------
-- private bucket, max 500KB, images only
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 512000, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 512000,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists hp_photos_read on storage.objects;
drop policy if exists hp_photos_ins on storage.objects;
drop policy if exists hp_photos_upd on storage.objects;
drop policy if exists hp_photos_del on storage.objects;
create policy hp_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.can_see(public.try_uuid((storage.foldername(name))[1])));
-- file names allowed: <uid>/<postId>_0_<ver>.jpg (cover) and <uid>/<postId>_1.jpg, _2.jpg (max 3 photos per post)
create policy hp_photos_ins on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text
    and name ~ '^[0-9a-f-]{36}/[A-Za-z0-9_-]{1,40}_(0_[a-z0-9]{1,20}|[12])\.jpg$');
create policy hp_photos_upd on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text
    and name ~ '^[0-9a-f-]{36}/[A-Za-z0-9_-]{1,40}_(0_[a-z0-9]{1,20}|[12])\.jpg$');
create policy hp_photos_del on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- Realtime (live updates) ----------
do $$ declare t text; begin
  foreach t in array array['profiles','follow_edges','follow_meta','posts','reacts','user_data'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- keep-alive ----------
-- the GitHub Action calls this every few days so the free project never pauses
create or replace function public.ping() returns text language sql stable as $$ select 'ok'::text $$;
grant execute on function public.ping() to anon, authenticated;

-- ---------- secret phrase (あいことば) for password reset without email ----------
-- The phrase is stored only as a bcrypt hash in a table nobody can read through the API.
-- 5 wrong tries lock that ID for 30 minutes. A successful reset signs the account out everywhere.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.secret_phrases(
  user_id uuid primary key references auth.users on delete cascade,
  hash text not null,
  fails int not null default 0,
  locked_until timestamptz
);
alter table public.secret_phrases enable row level security;
revoke all on public.secret_phrases from anon, authenticated;

-- signed-in user sets/changes their phrase; needs the current password
create or replace function public.set_secret_phrase(p_password text, p_phrase text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare u auth.users%rowtype;
begin
  select * into u from auth.users where id = auth.uid();
  if u.id is null or u.encrypted_password is null or extensions.crypt(p_password, u.encrypted_password) <> u.encrypted_password then
    return false;
  end if;
  if length(coalesce(p_phrase, '')) < 4 or length(p_phrase) > 100 then raise exception 'phrase length'; end if;
  insert into public.secret_phrases(user_id, hash) values (u.id, extensions.crypt(p_phrase, extensions.gen_salt('bf', 10)))
  on conflict (user_id) do update set hash = excluded.hash, fails = 0, locked_until = null;
  return true;
end $$;

-- anyone (signed out) can reset with ID + phrase; returns 'ok' | 'locked' | 'ng'
create or replace function public.reset_password_with_phrase(p_id text, p_phrase text, p_new_password text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid; s public.secret_phrases%rowtype; n int;
begin
  if length(coalesce(p_new_password, '')) < 8 or length(p_new_password) > 72 then raise exception 'password length'; end if;
  select id into uid from auth.users where email = lower(p_id) || '@harapangram.invalid';
  if uid is null then perform pg_sleep(0.3); return 'ng'; end if;
  select * into s from public.secret_phrases where user_id = uid for update;
  if s.user_id is null then perform pg_sleep(0.3); return 'ng'; end if;
  if s.locked_until is not null and s.locked_until > now() then return 'locked'; end if;
  if extensions.crypt(coalesce(p_phrase, ''), s.hash) <> s.hash then
    update public.secret_phrases set fails = fails + 1 where user_id = uid returning fails into n;
    if n >= 5 then
      update public.secret_phrases set fails = 0, locked_until = now() + interval '30 minutes' where user_id = uid;
    end if;
    return 'ng';
  end if;
  update auth.users set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf', 10)), updated_at = now() where id = uid;
  update public.secret_phrases set fails = 0, locked_until = null where user_id = uid;
  delete from auth.sessions where user_id = uid;
  return 'ok';
end $$;

-- does the signed-in user have a phrase yet?
create or replace function public.has_secret_phrase() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.secret_phrases where user_id = auth.uid())
$$;

revoke all on function public.set_secret_phrase(text, text) from public, anon;
revoke all on function public.reset_password_with_phrase(text, text, text) from public;
revoke all on function public.has_secret_phrase() from public, anon;
grant execute on function public.set_secret_phrase(text, text) to authenticated;
grant execute on function public.reset_password_with_phrase(text, text, text) to anon, authenticated;
grant execute on function public.has_secret_phrase() to authenticated;

-- ---------- finding people without listing everyone ----------
create or replace function public.find_user(p_handle text) returns table(id uuid, data jsonb)
language sql stable security definer set search_path = public as $$
  select p.id, p.data - 'inviteCode' - 'invitedBy' from public.profiles p
  where p.data->>'handle' = lower(trim(p_handle)) and auth.uid() is not null and not public.blocked_by(p.id)
  limit 1
$$;
create or replace function public.find_by_invite(p_code text) returns table(id uuid, data jsonb)
language sql stable security definer set search_path = public as $$
  select p.id, p.data - 'inviteCode' - 'invitedBy' from public.profiles p
  where p.data->>'inviteCode' = upper(trim(p_code)) and auth.uid() is not null and not public.blocked_by(p.id)
  limit 1
$$;
revoke all on function public.find_user(text) from public, anon;
revoke all on function public.find_by_invite(text) from public, anon;
grant execute on function public.find_user(text) to authenticated;
grant execute on function public.find_by_invite(text) to authenticated;

-- a friend's follow / follower lists: only for yourself or a mutual friend; people who blocked you are left out
create or replace function public.friend_lists(p_uid uuid) returns table(kind text, id uuid, data jsonb)
language sql stable security definer set search_path = public as $$
  select x.k, p.id, p.data - 'inviteCode' - 'invitedBy' from (
    select 'following'::text k, e.dst uid from public.follow_edges e where e.src = p_uid
    union all
    select 'followers'::text, e.src from public.follow_edges e where e.dst = p_uid) x
  join public.profiles p on p.id = x.uid
  where auth.uid() is not null and (p_uid = auth.uid() or public.is_mutual(auth.uid(), p_uid))
    and not public.blocked_by(p.id) and not public.blocked_by(p_uid)
$$;
revoke all on function public.friend_lists(uuid) from public, anon;
grant execute on function public.friend_lists(uuid) to authenticated;

-- ---------- reports (通報) ----------
-- R reads them in Supabase: Table Editor → reports
create table if not exists public.reports(
  id bigint generated always as identity primary key,
  reporter uuid not null default auth.uid() references auth.users on delete cascade,
  target uuid references auth.users on delete set null,
  post_id text,
  react_id text,
  reason text not null,
  detail text,
  created_at timestamptz not null default now(),
  constraint reports_reason check (length(reason) between 1 and 40),
  constraint reports_detail check (detail is null or length(detail) <= 400)
);
alter table public.reports enable row level security;
revoke all on public.reports from anon;
grant select, insert on public.reports to authenticated;
drop policy if exists reports_ins on public.reports;
drop policy if exists reports_read on public.reports;
create policy reports_read on public.reports for select to authenticated using (reporter = auth.uid());
create policy reports_ins on public.reports for insert to authenticated
  with check (reporter = auth.uid() and target is distinct from auth.uid()
    and (select count(*) from public.reports r where r.reporter = auth.uid() and r.created_at > now() - interval '1 day') < 20);

-- ---------- delete my account ----------
-- the page removes the photo files first (Storage API), then this deletes the login and every row (on delete cascade)
create or replace function public.delete_my_account(p_password text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare u auth.users%rowtype;
begin
  select * into u from auth.users where id = auth.uid();
  if u.id is null or u.encrypted_password is null or extensions.crypt(p_password, u.encrypted_password) <> u.encrypted_password then
    return false;
  end if;
  delete from auth.users where id = u.id;
  return true;
end $$;
revoke all on function public.delete_my_account(text) from public, anon;
grant execute on function public.delete_my_account(text) to authenticated;

-- checks the signed-in user's password (used before deleting the account)
create or replace function public.verify_my_password(p_password text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select extensions.crypt(p_password, u.encrypted_password) = u.encrypted_password
    from auth.users u where u.id = auth.uid() and u.encrypted_password is not null), false)
$$;
revoke all on function public.verify_my_password(text) from public, anon;
grant execute on function public.verify_my_password(text) to authenticated;
