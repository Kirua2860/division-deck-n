# Douzième Division – site de collection de cartes

Ouvre un booster (3 cartes) toutes les 4 h, découvre les personnages et complète ta collection.
5 raretés : Commune, Rare, Épique, Légendaire, Mythique.

## Fonctionnalités

- **Ouverture en grand** : un clic sur le booster l'ouvre au milieu de l'écran (plein écran). Le booster s'affiche en grand avec un bouton **Ouvrir** en bas ; au clic il tremble, se déchire, puis les 3 cartes apparaissent avec un son par rareté. Si des boosters restent, on peut enchaîner avec « Ouvrir un autre booster » (Échap ou × pour fermer).
- **Deux boosters** : **12e Division** (à gauche) et **Yamato** (à droite). Un clic sur celui qui n'est pas choisi change de booster, un clic sur celui qui est choisi l'ouvre. Chaque carte du catalogue appartient à un booster ou aux deux (champ « Booster » dans Admin → Cartes, filtre disponible dans le catalogue). Les anciennes cartes sont dans le booster 12e Division. Les 3 cartes d'un booster sortent des plus communes aux plus rares.
- **Boosters** : 3 cartes toutes les 4 h, tirées selon la rareté. En plus, un joueur peut avoir **plusieurs boosters en réserve** (donnés par les admins) et les ouvrir à la suite, sans attendre : le booster gratuit part en premier, puis la réserve.
- **Réglages** : son (volume général, boosters, interface, mute, jingle par rareté, carillon « booster prêt »), effets visuels (braises, coups de sabre, aura des cartes, mode calme), préréglages Complet / Discret / Silence, fond d'écran et couleur du texte. Les sons sont synthétisés dans le navigateur (aucun fichier audio) et les réglages son/effets sont gardés sur l'appareil.
- **Joueurs** : liste de tous les joueurs ; chacun peut consulter la collection des autres.
- **Vitrine** : chaque joueur expose jusqu'à 6 de ses cartes préférées sur son profil (publique).
- **Fond d'écran** (Réglages) : une **galerie de 6 fonds prédéfinis** (`public/wallpapers/`) ou sa **propre photo**, floutée et assombrie derrière le site. La photo perso est **privée** : seul son propriétaire la voit. La page indique la taille idéale (1920 × 1080, 16:9), les formats et le poids max, affiche les détails de la photo (dimensions, poids) et prévient si elle est trop petite ou en hauteur.
- **Codes cadeaux** : onglet **Code** pour les joueurs (entrer un code = recevoir des boosters en réserve, une fois par joueur et par code). Les admins créent les codes dans **Admin → Codes** : ils choisissent le code, le nombre de boosters (1 à 100) et, en option, le nombre maximum de joueurs. Les essais ratés sont limités (8 par 10 min).
- **Tickets** : un joueur envoie une demande de carte ; un admin accepte (en donnant une carte) ou refuse, avec un message.
- **Fiche carte** : un clic sur n'importe quelle carte ouvre sa fiche (grande image, description complète, rareté, probabilité de tirage, tes exemplaires).
- **Espace admin** (tableau de bord, cartes, joueurs, tickets, logo, accès) :
  - **Tableau de bord** : statistiques, répartition par rareté, meilleurs collectionneurs, tickets en attente.
  - **Cartes** : création (image obligatoire), modification, suppression simple ou groupée, recherche, filtre par rareté, tri, nombre de joueurs qui possèdent chaque carte.
  - **Joueurs** : donner ou retirer des cartes, réinitialiser le délai du booster, **donner ou retirer des boosters** (1 à 100 d'un coup) à un joueur ou **à tous les joueurs**.
- **Le site ne crée aucune carte** : le catalogue est vide au départ et il n'y a plus d'illustrations générées. Toutes les cartes sont créées par les admins.

## Configuration (obligatoire)

Il n'y a **pas de mode test** : le site refuse de démarrer sans connexion Discord ni secret de session.

1. Va sur https://discord.com/developers/applications → **New Application**.
2. Onglet **OAuth2** : copie le *Client ID* et le *Client Secret*.
3. Dans **Redirects**, ajoute : `https://12e-division-deck-production-29b8ed26.up.railway.app/auth/discord/callback`.
4. Définis ces variables d'environnement :

| Variable | Obligatoire | Exemple |
|---|---|---|
| `DISCORD_CLIENT_ID` | oui | `123456789` |
| `DISCORD_CLIENT_SECRET` | oui | `xxxxxxxx` |
| `BASE_URL` | oui | `https://12e-division-deck-production-29b8ed26.up.railway.app` |
| `SESSION_SECRET` | oui (16 car. min.) | une longue chaîne aléatoire |
| `DATA_FILE` | non (mais recommandé) | `/data/data.json` |
| `BACKUP_WEBHOOK_URL` | non (mais **fortement recommandé**) | `https://discord.com/api/webhooks/…` |
| `BACKUP_OFFSITE_MINUTES` | non | `60` (délai minimum entre 2 envois sur Discord) |

Puis : `npm install && npm start`.

## Fondateur et admins

- Le **fondateur** est le compte Discord `653263485362503693` (constante `FOUNDER_ID` dans `server.js`). Il est toujours admin.
- **Le fondateur est le seul à donner les accès** : onglet **Admin → Accès**, il donne ou retire les droits d'admin aux joueurs (qui se sont connectés au moins une fois). Se connecter ne donne aucun droit.

## Héberger sur Railway

1. Mets ce dossier sur GitHub.
2. Sur https://railway.app → **New Project → Deploy from GitHub**.
3. Ajoute les variables ci-dessus dans l'onglet **Variables**.
4. Ajoute un **Volume** monté sur `/data` et définis `DATA_FILE=/data/data.json`.
   Le fichier de données **et** les images (cartes, fonds d'écran, dans `/data/uploads`) sont alors conservés entre les déploiements.
   Sans volume, tout est perdu à chaque redéploiement.

## Sauvegarde

Chaque action est enregistrée immédiatement dans `data.json` (écriture atomique).

**Sauvegardes automatiques** (dossier `backups/`, à côté de `data.json`) :
- une copie au démarrage et à chaque arrêt du site ;
- une copie toutes les 10 min quand quelque chose a changé (30 conservées) ;
- une copie par jour (14 conservées) ;
- une copie « avant restauration » à chaque restauration ;
- une **copie des images** (cartes, fonds d'écran, logo) dans `backups/files/`, mise à jour à chaque sauvegarde.

**Restauration automatique** au démarrage : si `data.json` est absent ou abîmé, le site recharge la dernière sauvegarde valide ;
si des images utilisées sont absentes, elles sont remises en place depuis `backups/files/`.
S'il est abîmé et qu'aucune sauvegarde n'est utilisable, le site refuse de démarrer (il n'écrase jamais tes données) et garde une copie `data.json.corrupt-…`.

**Copie hors du site (indispensable pour survivre à l'arrêt / la suppression du site)** : toutes les copies ci-dessus sont sur le même disque que le site. Pour qu'une sauvegarde survive même si
l'hébergeur efface tout ou que le site est supprimé, crée un **webhook Discord** dans un salon privé (Salon → Intégrations → Webhooks → Nouveau webhook → Copier l'URL)
et mets-la dans `BACKUP_WEBHOOK_URL`. Le site y envoie alors un fichier `.json.gz` :
- à chaque arrêt, redéploiement **ou plantage** du site ;
- au démarrage et dès que quelque chose change, au plus toutes les heures (réglable : `BACKUP_OFFSITE_MINUTES`, 5 min minimum).

Le fichier « données » (joueurs, collections, cartes, tickets) est **toujours** complet. Si les images tiennent sous la limite (9 Mo, réglable avec `BACKUP_WEBHOOK_MAX_MB`), elles sont dans le même fichier ;
sinon elles partent dans des fichiers « images » séparés (découpés automatiquement), envoyés seulement quand elles changent.
Pour récupérer : **Admin → Sauvegardes → Importer une sauvegarde complète**, et sélectionne d'un coup le fichier « données » (ou « complet ») + les fichiers « images » téléchargés depuis Discord (`.json.gz`, pas besoin de les décompresser).

**Onglet Admin → Sauvegardes** (fondateur uniquement) : sauvegarder maintenant, télécharger / restaurer une copie,
envoyer une copie sur Discord, **télécharger la sauvegarde complète** et l'**importer** sur un site vide.

⚠ Sur un hébergeur sans disque persistant (Railway sans Volume…), le dossier de données disparaît à chaque redéploiement, `backups/` compris.
Monte un Volume sur `/data` avec `DATA_FILE=/data/data.json` **et** configure `BACKUP_WEBHOOK_URL`.

## Personnaliser

- **Probabilités / noms des raretés** : `RARITIES` dans `cards.js` (la Mythique a un poids de 1, soit environ 1 % des tirages quand toutes les raretés ont des cartes).
- **Délai / taille du booster / taille de la vitrine** : `COOLDOWN_MS`, `BOOSTER_SIZE`, `SHOWCASE_MAX` dans `server.js`.

## Pour aller plus loin

- Passer du fichier JSON à une vraie base (SQLite, PostgreSQL) si le site grandit.
- Échanges entre joueurs, classement, cartes brillantes, notifications quand un ticket est traité.
