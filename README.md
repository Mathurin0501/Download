# Transfert QR — V9 (version de test)

Application statique pour GitHub Pages. Aucune infrastructure supplémentaire, aucun TURN. Le service de signalisation PeerJS existant et les services STUN publics restent nécessaires. Les fichiers circulent directement via WebRTC quand les réseaux le permettent.

## Modifications

- HTML, CSS, images et boutons inchangés. Seuls les textes d’état évoluent.
- Jusqu’à cinq destinataires par session, avec le même code. Le débit et les fenêtres d’envoi sont répartis entre les connexions actives. Le code reste visible dans le sous-titre pendant et après les transferts.
- Stockage OPFS par worker dédié et contrôle du quota. En l’absence de stockage disque compatible, le total des fichiers conservés en RAM est plafonné à 8 Mio sur mobile et 32 Mio sur ordinateur, hors mémoire tampon de transport et surcharge du navigateur. Un fichier trop gros est refusé plutôt que chargé entièrement en RAM.
- Les données écrites sur disque sont synchronisées avant les accusés de réception. Après fermeture/rechargement du récepteur, rouvrir le même lien ou saisir le même code dans le même profil de navigateur, tant que l’émetteur conserve la session et le fichier source. Une portion non confirmée peut être retransmise. Les métadonnées sont conservées dans localStorage ; les données sont conservées dans OPFS. Sans OPFS, la reprise après fermeture n’est pas disponible.
- Si l’émetteur ferme sa page, le code et le fichier source ne sont pas restaurés : créer un nouveau partage et recommencer. Cette version ne met pas en cache les fichiers source, afin d’éviter une seconde copie potentiellement très volumineuse.
- SHA-256 et CRC32 sur chaque bloc, validation des métadonnées et accusés, limitation des connexions et des buffers, expiration après une période d’inactivité d’au moins 30 minutes. Aucun nouveau mot de passe ou code de vérification. Le code de partage reste un secret d’accès : toute personne qui le possède peut demander le fichier.
- Les fichiers reçus et checkpoints de plus de 48 h sont éligibles au nettoyage lors d’une réception ultérieure. La durée réelle dépend aussi de la gestion du stockage par le navigateur. Le navigateur peut supprimer les données locales ; conserver les fichiers téléchargés.
- STUN Google et Cloudflare, tentatives ICE renouvelées par reconnexion, délai de négociation augmenté, reprise au retour du réseau. Certains NAT/pare-feu restent incompatibles avec un transfert direct, sans TURN.
- Le protocole V9 n’est pas compatible avec V8. Mettre à jour les deux appareils. Le ZIP classique conserve sa limite d’environ 4 Go ; envoyer les fichiers séparément au-delà.

## Installation

Créer une branche de test dans GitHub, puis remplacer `index.html`, `robust-transfer.js` et `sw.js`, et ajouter `storage-worker.js`. Les icônes et le manifeste peuvent rester en place. Publier la branche de test uniquement si souhaité. Le nouveau service worker renouvelle le cache PWA. Recharger la page sur les deux appareils ; si nécessaire, fermer puis rouvrir les onglets de l’application.

## Tests

Node.js 22 : `node --test tests/test_engine.mjs tests/test_persistence.mjs`.

Les huit tests simulés ont réussi : intégrité octet par octet, fichier vide, deux envois parallèles, reprise après perte du canal, plafond RAM, rejet des fichiers inattendus, rejet SHA-256 invalide, reprise depuis un checkpoint disque simulé avec une nouvelle instance.

Le test navigateur `python tests/test_browser.py` nécessite Playwright et Chromium (`pip install playwright`, définir `CHROMIUM_PATH` si nécessaire). Son exécution a été bloquée par la politique de navigation de l’environnement. Il reste indispensable de valider sur deux appareils réels avant publication définitive : fichier de 1 à 5 Go, fermeture du récepteur en milieu de transfert, plusieurs récepteurs, Wi-Fi/5G, absence d’OPFS. Les tests simulés ne mesurent ni le débit réel ni la consommation de mémoire native du navigateur. La configuration STUN n’a pas pu être testée sur Internet.
