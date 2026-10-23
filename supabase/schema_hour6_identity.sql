-- SplitSmart Hour 6 follow-up: restore anonymous memberships by entered email
-- and expose group members for the participants list.

alter table public.group_members
  add column if not exists member_email text;

update public.group_members as membership
set member_email = lower(trim(coalesce(
  auth_user.raw_user_meta_data ->> 'unverified_email',
  auth_user.email
)))
from auth.users as auth_user
where membership.user_id = auth_user.id
  and membership.member_email is null
  and coalesce(auth_user.raw_user_meta_data ->> 'unverified_email', auth_user.email) is not null;

with duplicate_memberships as (
  select row_id
  from (
    select ctid as row_id,
      row_number() over (
        partition by group_id, lower(member_email)
        order by joined_at, user_id
      ) as row_number
    from public.group_members
    where member_email is not null
  ) as ranked
  where row_number > 1
)
delete from public.group_members as membership
using duplicate_memberships
where membership.ctid = duplicate_memberships.row_id;

create unique index if not exists group_members_group_email_key
  on public.group_members (group_id, lower(member_email))
  where member_email is not null;

create or replace function public.restore_email_group_memberships()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  current_email text := lower(trim(auth.jwt() -> 'user_metadata' ->> 'unverified_email'));
  membership record;
begin
  if current_user_id is null then
    raise exception 'Sign in before restoring group memberships';
  end if;
  if current_email is null or current_email = '' then
    raise exception 'The current session has no entered email address';
  end if;

  for membership in
    select distinct group_id
    from public.group_members
    where lower(member_email) = current_email
  loop
    delete from public.group_members
    where group_id = membership.group_id
      and lower(member_email) = current_email
      and user_id <> current_user_id;

    insert into public.group_members (group_id, user_id, member_email)
    values (membership.group_id, current_user_id, current_email)
    on conflict (group_id, user_id)
    do update set member_email = excluded.member_email;
  end loop;
end;
$$;

create or replace function public.join_group(code text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_group_id uuid;
  current_user_id uuid := auth.uid();
  current_email text := lower(trim(auth.jwt() -> 'user_metadata' ->> 'unverified_email'));
begin
  if current_user_id is null then
    raise exception 'Sign in before joining a group';
  end if;
  if current_email is null or current_email = '' then
    raise exception 'The current session has no entered email address';
  end if;

  select id into target_group_id
  from public.groups
  where join_code = upper(trim(code));

  if target_group_id is null then
    raise exception 'No group with that code';
  end if;

  delete from public.group_members
  where group_members.group_id = target_group_id
    and lower(member_email) = current_email
    and user_id <> current_user_id;

  insert into public.group_members (group_id, user_id, member_email)
  values (target_group_id, current_user_id, current_email)
  on conflict (group_id, user_id)
  do update set member_email = excluded.member_email;

  return target_group_id;
end;
$$;

revoke all on function public.restore_email_group_memberships() from public;
grant execute on function public.restore_email_group_memberships() to authenticated;
revoke all on function public.join_group(text) from public;
grant execute on function public.join_group(text) to authenticated;

drop policy if exists "see my memberships" on public.group_members;
drop policy if exists "see group memberships" on public.group_members;
create policy "see group memberships"
  on public.group_members for select to authenticated
  using (is_group_member(group_id));

drop policy if exists "join groups" on public.group_members;
create policy "join groups"
  on public.group_members for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and lower(member_email) = lower((select auth.jwt() -> 'user_metadata' ->> 'unverified_email'))
  );

drop policy if exists "creators can see their groups" on public.groups;
create policy "creators can see their groups"
  on public.groups for select to authenticated
  using (created_by = (select auth.uid()));

drop policy if exists "update group expenses" on public.expenses;
create policy "update group expenses"
  on public.expenses for update to authenticated
  using (is_group_member(group_id))
  with check (is_group_member(group_id));

drop policy if exists "Email users can read expenses" on public.expenses;
drop policy if exists "Email users can add expenses" on public.expenses;
drop policy if exists "Email users can update expenses" on public.expenses;
drop policy if exists "Email users can delete expenses" on public.expenses;
drop policy if exists "Users can read their expenses" on public.expenses;
drop policy if exists "Users can add their expenses" on public.expenses;
drop policy if exists "Users can update their expenses" on public.expenses;
drop policy if exists "Users can delete their expenses" on public.expenses;

grant select, insert on public.groups to authenticated;
grant select, insert on public.group_members to authenticated;

-- Old expense rows that used the literal name "You" now use the member's
-- name inferred from the local part of their stored email.
with group_owners as (
  select distinct on (group_id, lower(member_email))
    group_id,
    lower(member_email) as member_email,
    initcap(regexp_replace(split_part(member_email, '@', 1), '[._+-]+', ' ', 'g')) as display_name
  from public.group_members
  where member_email is not null
  order by group_id, lower(member_email), joined_at
)
update public.expenses as expense
set paid_by = owner.display_name
from group_owners as owner
where expense.group_id = owner.group_id
  and lower(expense.owner_email) = owner.member_email
  and expense.paid_by = 'You';

with group_owners as (
  select distinct on (group_id, lower(member_email))
    group_id,
    lower(member_email) as member_email,
    initcap(regexp_replace(split_part(member_email, '@', 1), '[._+-]+', ' ', 'g')) as display_name
  from public.group_members
  where member_email is not null
  order by group_id, lower(member_email), joined_at
)
update public.expenses as expense
set split_between = array(
  select case when participant.name = 'You' then owner.display_name else participant.name end
  from unnest(expense.split_between) with ordinality as participant(name, position)
  order by participant.position
)
from group_owners as owner
where expense.group_id = owner.group_id
  and lower(expense.owner_email) = owner.member_email
  and 'You' = any(expense.split_between);

notify pgrst, 'reload schema';
