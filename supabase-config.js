/* =====================================================================
   LA BOCA NEGRA — configuration Supabase
   UN SEUL endroit à compléter : ne recopie jamais ces valeurs ailleurs.

   1. URL  : déjà renseignée (ton projet existe bien, l'API répond).
   2. CLÉ  : Project Settings → API → « anon public » → Copier.

   La clé « anon » est PUBLIQUE par conception : toute personne.visitant le
   site peut la lire. Ce n'est pas un problème tant que les politiques RLS du
   fichier supabase-schema.sql sont en place (lecture seule + fonctions).
   ⚠ La clé « service_role » ne doit JAMAIS apparaître dans une page web :
   elle donnerait le contrôle total de la base à chaque visiteur. Si elle
   apparaît un jour dans le code, change-la immédiatement dans Supabase.
   ===================================================================== */
window.LABOCA_SUPABASE = {
  URL : 'https://dggjgrhriizxpvmnchun.supabase.co',
  ANON: 'sb_publishable_ENfDdd3GpwtXUcYW1SoE1w_rGa2dDk7',

  /* Rechargement de secours si la connexion temps réel se coupe (Wi-Fi du
     restaurant, onglet ouvert toute la journée). En secondes. */
  SECOURS: 30
};