/* =====================================================================
   LA BOCA NEGRA - couche de données Supabase
   Remplace l'ancien localStorage : le navigateur ne « possède » plus rien,
   la base est la seule source de vérité.

   Règle de conception : ce fichier ne connaît QUE Supabase. Il ne touche ni
   au plan, ni aux créneaux, ni au dessin. Il lit et écrit des enregistrements
   ayant exactement les mêmes noms de champs que l'ancien tableau RESA
   (table/debut/fin/pers/plus/statut), de sorte qu'etat(), draw(), panel(),
   conflit() et resume() restent inchangés.

   CONFIDENTIALITÉ — à lire avant de modifier.
   On ne lit QUE la table publique `creneaux` (occupation + effectif). La table
   `bookings`, qui contient le nom et le téléphone des clients, n'est lisible
   par AUCUN visiteur : c'est ce qui permet d'ouvrir la lecture du plan au
   public. Conséquence directe : le miroir RESA n'a ni `nom`, ni `tel`, ni
   jeton d'annulation — l'annulation est donc vérifiée par la BASE
   (cancel_booking compare le numéro saisi à la ligne privée).
   Ne jamais remettre un `select('*')` sur `bookings` ici.
   ===================================================================== */
(function () {
  const CFG = window.LABOCA_SUPABASE || {};
  const CLE = CFG.ANON || '';
  /* Une vraie clé Supabase anon est un JWT à TROIS segments
     (en-tête . charge utile . signature, ex. "eyJhbGciOi…​.eyJyb2xl…​.sOu…"),
     ou une clé publiable ("sb_publishable_…"). On vérifie la FORME, pas
     seulement la longueur : sinon le texte d'exemple passe le test, le site
     croit être configuré et envoie toutes ses requêtes avec une fausse clé. */
  const FORME_URL = /^https:\/\/[a-z0-9-]+\.supabase\.co$/;
  const FORME_CLE = /^(eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}|sb_publishable_[A-Za-z0-9_-]{20,})$/;
  const EXEMPLE = /COLLEZ|A_REMPLIR|VOTRE_|PASTE|CHANGE_MOI|YOUR_/i;
  const PRET = FORME_URL.test(CFG.URL || '') && FORME_CLE.test(CLE) && !EXEMPLE.test(CLE);
  if (CFG.ANON && !PRET)
    console.warn('[LA BOCA] Clé anon invalide ou encore en exemple : le plan '
      + 'sera visible mais aucune réservation ne pourra être enregistrée.');

  /* Motifs d'erreur Postgres → phrase claire pour le client (c'est ce que la
     base renvoie quand elle refuse une réservation). */
  const MOTS = {
    table_inconnue         : 'Cette table n\'existe pas.',
    jour_passe             : 'Choisissez une date à venir.',
    trop_lointain          : 'La prise de réservations n\'est ouverte que 30 jours à l\'avance.',
    heure_passee           : 'Cet horaire est déjà passé, choisissez-en un autre.',
    hors_service           : 'Les réservations ne sont possibles qu\'entre 13:00 et 20:00.',
    effectif_invalide      : 'Nombre de personnes incorrect.',
    effectif_trop_grand    : 'Trop de personnes pour cette table.',
    coordonnees_incompletes: 'Nom ou téléphone incomplet.',
    annulation_refusee     : 'Téléphone incorrect, la réservation est maintenue.'
  };

  function lisible(e) {
    const c = (e && e.code) || '', m = String((e && e.message) || '');
    /* 23P01 = exclusion_violation : le verrou anti-double-réservation a joué */
    if (c === '23P01' || /bookings_sans_chevauchement|reservations_sans_chevauchement/.test(m))
      return 'Désolé, ce créneau vient d\'être pris.';
    if (MOTS[m]) return MOTS[m];
    for (const k in MOTS) if (m.indexOf(k) >= 0) return MOTS[k];
    if (c === '42501') return 'Réservation impossible pour le moment.';
    return 'Connexion au service de réservation impossible. Merci d\'appeler le restaurant.';
  }

  let client = null;
  if (PRET && window.supabase) {
    /* auth désactivée : aucune session, aucun jeton conservé sur l'appareil.
       Ce site n'a pas de comptes utilisateurs, il n'en faut aucun. */
    client = window.supabase.createClient(CFG.URL, CLE,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  } else {
    console.error('[LA BOCA] Supabase non configuré : vérifie supabase-config.js ' +
      '(clé « anon public » manquante) et que le script UMD est bien chargé.');
  }

  /* ligne PUBLIQUE (creneaux) → enregistrement attendu par reservation.html.
     Remarque importante : ni `nom`, ni `tel`, ni jeton d'annulation ne
     traversent cette frontière — le navigateur ne connaît que l'occupation
     des tables. C'est ce qui permet d'ouvrir la lecture au public. */
  const versApp = r => ({
    id: r.id, table: r.table_number,
    pers: r.pers, plus: r.plus, debut: r.debut, fin: r.fin,
    jour: r.jour, statut: r.statut
  });

  const SUP = {
    ok: PRET && !!client,
    lisible: lisible,
    secours: (CFG.SECOURS || 30) * 1000,

    /* Les créneaux du jour. La table lue est la projection PUBLIQUE
       `creneaux` : les coordonnées des clients n'y sont pas, donc cette
       requête ne peut rien divulguer, même appelée directement sur l'API. */
    async charge(jour) {
      const { data, error } = await client.from('creneaux').select('*')
        .eq('jour', jour).neq('statut', 'cancelled').order('debut');
      if (error) throw error;
      return (data || []).map(versApp);
    },

    /* Insertion validée côté serveur ; rejette le doublon (23P01).
       Le nom et le téléphone ne servent qu'à l'écriture : ils vont dans la
       table privée et ne reviennent jamais ici. */
    async reserver(p) {
      const { data, error } = await client.rpc('book_slot', {
        p_jour: p.jour, p_table: p.table, p_debut: p.debut,
        p_nom: p.nom, p_tel: p.tel, p_pers: p.pers, p_plus: !!p.plus
      });
      if (error) throw error;
      return versApp(data);
    },

    /* Annulation : la base compare le téléphone saisi à celui de la ligne
       privée. Un mauvais numéro est refusé par le serveur — impossible de
       supprimer la réservation de quelqu'un d'autre en devinant. */
    async annuler(id, tel) {
      if (!id || !tel) return false;
      const { data, error } = await client.rpc('cancel_booking', { p_id: id, p_tel: tel });
      if (error) throw error;
      return data === true;
    },

    /* Une seule connexion Realtime à la fois ; rouverte si le jour change. */
    canal: null,
    souscrire(jour, fn) {
      if (!this.ok) return;
      this.jette();
      this.canal = client.channel('plan-' + jour)
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'creneaux', filter: 'jour=eq.' + jour },
            fn)
        .subscribe();
    },
    jette() {
      if (!this.canal) return;
      client.removeChannel(this.canal);
      this.canal = null;
    }
  };

  window.SUP = SUP;
})();