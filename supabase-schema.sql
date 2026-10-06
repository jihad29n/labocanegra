-- =====================================================================
--  LA BOCA NEGRA — schéma Supabase
--  À coller dans : Supabase → SQL Editor → New query → Run
--  Ce fichier est idempotent : tu peux le relancer sans casser la base.
-- =====================================================================
--
--  POURQUOI DEUX TABLES ?
--
--  La clé « anon » est PUBLIQUE : elle est lisible dans le code de la page.
--  Tout ce que la base laisse lire à `anon`, n'importe quel visiteur peut
--  lire — y compris en appelant l'API directement, sans passer par la page.
--
--  Or « le temps réel » (postgres_changes) envoie la LIGNE ENTIÈRE d'un
--  changement : les politiques RLS filtrent des LIGNES, pas des COLONNES.
--  Une seule table contenant nom + téléphone rendrait donc les coordonnées
--  de tous les clients lisibles par tous les visiteurs. C'est inacceptable.
--
--  D'où la séparation :
--    • bookings  = données PRIVÉES (nom, téléphone, statut de confirmation).
--                  Aucune politique pour anon/authenticated : lecture interdite.
--                  Le personnel y accède par le tableau de bord Supabase
--                  (ou via la clé service_role, JAMAIS dans le site).
--    • creneaux  = projection PUBLIQUE et sans secret : le jour, la table,
--                  l'heure de début/fin et le statut. C'est la seule table
--                  que le public lit… et la seule que le temps réel diffuse.
--    Un déclencheur recopie bookings → creneaux à chaque écriture.
--
--  Conséquence : le client ne connaît plus le téléphone des autres, ni aucun
--  jeton d'annulation. L'annulation est vérifiée côté serveur (§7).
-- =====================================================================

-- 1. Intervalle de temps « sans chevauchement » sur des plages d'entiers
--    (nécessaire pour interdire deux réservations qui se recouvrent).
create extension if not exists btree_gist;

-- 2. La table PRIVÉE des réservations.
--    ATTENTION : pas de colonne « status » sur les TABLES.
--    Le statut d'une table (libre / réservée / à venir) reste CALCULÉ à partir
--    des réservations du jour — c'est le principe « état dérivé » déjà retenu
--    dans reservation.html : une table ne peut pas rester rouge indéfiniment
--    parce qu'une ligne « booked » traînerait en base.
create table if not exists public.bookings (
  id           uuid primary key default gen_random_uuid(),
  jour         date        not null,             -- jour de service, calculé à TANGER (GMT+1)
  table_number int         not null,             -- 1..41, cf. ROOMS dans reservation.html
  debut        int         not null,             -- minutes depuis minuit, comme l'application
  fin          int         not null,
  nom          text        not null,             -- PRIVÉ
  tel          text        not null,             -- PRIVÉ
  pers         int         not null default 2 check (pers between 1 and 10),
  plus         boolean     not null default false,
  status       text        not null default 'pending'
                 check (status in ('pending','confirmed','cancelled')),
  created_at   timestamptz not null default now(),
  constraint reservations_fin_debut check (fin - debut = 90)   -- DUREE = 90 min
);

-- 2 bis. Si une ancienne version de ce fichier (qui avait cancel_token) a
--      déjà été exécutée, on retire la colonne et son index.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='bookings'
                and column_name='cancel_token') then
    execute 'alter table public.bookings drop column cancel_token';
  end if;
end;
$$;

-- 3. LE VERROU.
--    Deux réservations ne peuvent pas se chevaucher sur une même table un même
--    jour. C'est ici que se joue la sécurité : la clé « anon » étant publique,
--    n'importe qui peut envoyer une requête HTTP directement à l'API en
--    contournant le JavaScript. Cette contrainte rend cela IMPOSSIBLE côté
--    base, même dans ce cas. Le test conflit() du navigateur ne sert qu'à
--    l'affichage immédiat, jamais de garantie.
create unique index if not exists reservations_sans_chevauchement
  on public.bookings (table_number, jour, int4range(debut, fin, '[)'))
  where status <> 'cancelled';

-- 4. Sécurité sur bookings : lecture INTERDITE au public.
--    RLS activée et AUCUNE politique pour anon/authenticated.
--    Seul « postgres » (le propriétaire, via SECURITY DEFINER) y accède :
--    les fonctions §6 et §7, et le tableau de bord du personnel.
alter table public.bookings enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies
            where schemaname='public' and tablename='bookings' loop
    execute format('drop policy %I on public.bookings', p.policyname);
  end loop;
end;
$$;

revoke all on public.bookings from anon, authenticated;

-- 5. La projection PUBLIQUE : ce que le plan a le droit de savoir.
--    On y met l'OCCUPATION et l'EFFECTIF, jamais l'identité. L'effectif est
--    nécessaire au plan (« table pour 4 personnes ») et ne dit rien de la
--    personne : c'est le nom et le téléphone qui restent privés.
create table if not exists public.creneaux (
  id           uuid primary key references public.bookings(id) on delete cascade,
  jour         date        not null,
  table_number int         not null,
  debut        int         not null,
  fin          int         not null,
  pers         int         not null default 2,
  plus         boolean     not null default false,
  statut       text        not null default 'pending'
                 check (statut in ('pending','confirmed')),
  maj_le       timestamptz not null default now()
);

-- si une version précédente de ce fichier a créé la table sans ces colonnes
alter table public.creneaux add column if not exists pers  int        not null default 2;
alter table public.creneaux add column if not exists plus  boolean   not null default false;

create index if not exists creneaux_jour on public.creneaux (jour, debut);

alter table public.creneaux enable row level security;

drop policy if exists lecture_creneaux on public.creneaux;
create policy lecture_creneaux on public.creneaux
  for select
  to anon, authenticated
  using (true);

-- Le public lit, il n'écrit jamais : pas de politique insert/update/delete.
revoke all on public.creneaux from anon, authenticated;
grant select on public.creneaux to anon, authenticated;

-- 5 bis. Le déclencheur qui recopie bookings → creneaux.
--      SECURITY DEFINER : il écrit dans creneaux alors que le public n'a pas
--      le droit d'écrire. Une réservation annulée DISPARAÎT de la projection
--      (le créneau redevient réservable sans qu'aucune ligne « annulée »
--      traîne dans la liste des tables).
create or replace function public.bookings_vers_creneaux()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.creneaux where id = old.id;
    return old;
  end if;

  if new.status = 'cancelled' then
    delete from public.creneaux where id = new.id;
  else
    insert into public.creneaux (id, jour, table_number, debut, fin, pers, plus, statut, maj_le)
    values (new.id, new.jour, new.table_number, new.debut, new.fin,
            new.pers, new.plus, new.status, now())
    on conflict (id) do update
      set table_number = excluded.table_number,
          debut        = excluded.debut,
          fin          = excluded.fin,
          pers         = excluded.pers,
          plus         = excluded.plus,
          statut       = excluded.statut,
          maj_le       = now();
  end if;
  return new;
end;
$$;

drop trigger if exists miroir_creneaux on public.bookings;
create trigger miroir_creneaux
  after insert or update or delete on public.bookings
  for each row execute function public.bookings_vers_creneaux();

-- 6. LE JOUR DE SERVICE, CÔTÉ SERVEUR.
--    Doit tomber d'accord avec le navigateur, qui calcule tout en Etc/GMT-1
--    (UTC+01:00 FIXE, toute l'année).
--    NE PAS utiliser « Africa/Casablanca » : les règles IANA y modélisent une
--    heure d'été NÉGATIVE, si bien que Postgres la placerait une heure en
--    retard et refuserait des réservations que la page vient d'accepter (c'est
--    exactement le bug d'horloge qui a fait passer la page à GMT+1). Un décalage
--    fixe de +1 h ne dérive jamais.
create or replace function public.heur_tanger()
returns timestamptz
language sql
stable
as $$ select (now() at time zone 'UTC') + interval '1 hour' $$;

create or replace function public.aujourdhui_tanger()
returns date
language sql
stable
as $$ select (public.heur_tanger())::date $$;

-- nombre de minutes écoulées dans la journée de service, à Tanger
create or replace function public.minute_tanger()
returns int
language sql
stable
as $$
  select (extract(hour   from public.heur_tanger()) * 60
        + extract(minute from public.heur_tanger()))::int
$$;

-- 6 bis. Réserver un créneau.
--     Tout est revalidé ici : DATE, horaires, effectif, identité. On ne fait
--     jamais confiance à ce que le navigateur a calculé — un appel direct à
--     l'API avec une date passée doit être refusé par la base, pas seulement
--     par la page.
--     Elle renvoie une ligne de CRENEAUX (jamais les coordonnées du client).
--     HORIZON : nombre maximal de jours à l'avance acceptés par le restaurant.
create or replace function public.book_slot(
  p_jour  date,
  p_table int,
  p_debut int,
  p_nom   text,
  p_tel   text,
  p_pers  int,
  p_plus  boolean default false
) returns public.creneaux
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id       uuid;
  v_aujourdhui date := public.aujourdhui_tanger();
  v_horizon  date   := public.aujourdhui_tanger() + 30;
begin
  -- la date elle-même : ni passé, ni lointain
  if p_jour is null or p_jour < v_aujourdhui then
    raise exception 'jour_passe' using errcode = '22023';
  end if;
  if p_jour > v_horizon then
    raise exception 'trop_lointain' using errcode = '22023';
  end if;
  if p_table < 1 or p_table > 41 then
    raise exception 'table_inconnue' using errcode = '22023';
  end if;
  -- dernier DÉBUT autorisé = 20:00 (la réservation court alors jusqu'à 21:30)
  if p_debut < 780 or p_debut > 1200 then
    raise exception 'hors_service' using errcode = '22023';
  end if;
  -- Pour AUJOURD'HUI seulement, l'heure doit être encore à venir.
  -- 5 min de tolérance : l'horloge du téléphone et celle du serveur ne sont
  -- jamais rigoureusement identiques, on ne veut pas refuser le créneau que le
  -- client vient légitimement de choisir.
  if p_jour = v_aujourdhui and p_debut < public.minute_tanger() - 5 then
    raise exception 'heure_passee' using errcode = '22023';
  end if;
  if p_pers < 1 or p_pers > 10 then
    raise exception 'effectif_invalide' using errcode = '22023';
  end if;
  if length(trim(p_nom)) < 2
     or length(regexp_replace(p_tel, '\D', '', 'g')) < 6 then
    raise exception 'coordonnees_incompletes' using errcode = '22023';
  end if;

  -- C'est CET INSERT qui peut échouer sur le verrou anti-chevauchement (§3) :
  -- aucune application ne peut doubler une réservation, même via une
  -- requête directe envoyée à l'API.
  insert into public.bookings
    (jour, table_number, debut, fin, nom, tel, pers, plus)
  values
    (p_jour, p_table, p_debut, p_debut + 90, trim(p_nom),
     regexp_replace(p_tel, '\D', '', 'g'), p_pers, coalesce(p_plus, false))
  returning id into v_id;

  -- le déclencheur a déjà rempli creneaux : on relit cette ligne
  return (select c from public.creneaux c where c.id = v_id);
end;
$$;

grant execute on function public.book_slot(date,int,int,text,text,int,boolean)
  to anon, authenticated;

-- 7. Annuler sa réservation.
--    La preuve est le couple (identifiant de la réservation + numéro de
--    téléphone utilisé). La comparaison se fait ICI, dans la base, sur la
--    ligne privée : le navigateur ne connaît ni le téléphone des autres ni
--    aucun jeton. Deviner un identifiant ne suffit pas sans le bon numéro.
create or replace function public.cancel_booking(p_id uuid, p_tel text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  if p_id is null or length(regexp_replace(coalesce(p_tel,''), '\D', '', 'g')) < 6 then
    raise exception 'coordonnees_incompletes' using errcode = '22023';
  end if;

  -- le numéro ne correspond pas : on ne distingue pas « mauvaise saisie »
  -- de « réservation inexistante », pour ne pas laisser deviner les lignes.
  if not exists (
    select 1 from public.bookings b
     where b.id = p_id
       and b.status <> 'cancelled'
       and b.tel = regexp_replace(p_tel, '\D', '', 'g')
  ) then
    raise exception 'annulation_refusee' using errcode = '22023';
  end if;

  update public.bookings set status = 'cancelled' where id = p_id;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

grant execute on function public.cancel_booking(uuid, text) to anon, authenticated;

-- 8. Synchronisation temps réel.
--    Obligatoire, sinon le navigateur ne recevra aucune notification et le
--    plan ne se rafraîchira que lors d'un rechargement de la page.
--    SEULEMENT creneaux est publié : bookings contient les coordonnées des
--    clients et ne doit jamais être diffusé.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'creneaux'
  ) then
    alter publication supabase_realtime add table public.creneaux;
  end if;
  -- sécurité : si une version précédente avait publié bookings, on retire.
  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'bookings'
  ) then
    alter publication supabase_realtime drop table public.bookings;
  end if;
end;
$$;

-- 9. Vérification (facultatif) : colle ceci dans le SQL Editor après avoir
--    exécuté le fichier ci-dessus, les deux premières lignes doivent
--    afficher 0.
--    select count(*) as politiques_bookings
--      from pg_policies where tablename = 'bookings';      -- attendu : 0
--    select count(*) as politiques_creneaux
--      from pg_policies where tablename = 'creneaux';      -- attendu : 1
--    select count(*) as temps_reel
--      from pg_publication_tables
--     where pubname='supabase_realtime' and tablename='creneaux';  -- attendu : 1
--    select count(*) as fuite_possible
--      from pg_publication_tables
--     where pubname='supabase_realtime' and tablename='bookings';  -- attendu : 0
--
--    Contrôle du jour de service : doit être AUJOURD'HUI à Tanger. Si la base
--    affiche la veille, c'est que le fuseau du projet est réglé autrement que
--    Etc/GMT-1 — signale-le, les dates seraient fausses.
--    select public.heur_tanger(), public.aujourdhui_tanger(),
--           public.minute_tanger();

-- 10. GESTION PAR LE PERSONNEL
--     Les réservations arrivent « pending ». Pour confirmer ou annuler :
--       select * from public.bookings order by jour, debut;
--     puis, dans le tableau de bord (Data → bookings) :
--       update public.bookings set status = 'confirmed' where id = '…';
--       update public.bookings set status = 'cancelled' where id = '…';
--     Le déclencheur met creneaux à jour et le temps réel prévient les
--     navigateurs : l'annulation fait libérer la table chez tout le monde.

-- 11. OPTIONNEL — capacité des tables côté serveur.
--     Pour que la base puisse aussi refuser un effectif trop grand, il faut
--     connaître la capacité de chaque table. Renseigne d'abord public.tables
--     avec les 41 lignes (table_number 1..41), puis :
--
--     alter table public.tables
--       add column capacity int not null default 4 check (capacity between 1 and 10);
--     -- sq = 4, rv = 6, rl = 8, rd = 6  (cf. SEATS dans reservation.html)
--     update public.tables set capacity = 4;  -- puis ajuste table par table
--
--     -- et dans book_slot(), après le test sur p_table :
--     --   if p_pers > (select capacity from public.tables where table_number = p_table)
--     --   then raise exception 'effectif_trop_grand' using errcode = '22023'; end if;
