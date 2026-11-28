# Transfert QR — V11 (correctif de la V10)

Application statique pour GitHub Pages, sans TURN ni serveur supplémentaire à héberger. PeerJS et les services STUN publics existants restent nécessaires pour la mise en relation. Les fichiers circulent en WebRTC direct lorsque les réseaux le permettent.

## Correctifs

- Corrige l'apostrophe non échappée dans le texte du mode Liens, qui empêchait l'intégralité du module JavaScript de s'exécuter dans la V10.
- Navigation entre Téléphone, PC à PC et Liens ; génération des QR dans les trois modes ; si une bibliothèque CDN manque, les boutons de navigation restent utilisables et un message explique le problème.
- QR de partage affichable pendant et après un envoi, avec le même lien pour jusqu'à cinq destinataires par session. Le CSS d'origine est inchangé ; seuls les contrôles nécessaires au partage ont été ajoutés.
- Fenêtre globale d'envoi plafonnée à 12 Mio sur PC et 4 Mio sur mobile, et buffer à 6/2 Mio, répartis entre connexions. Ces réglages restent sous le seuil de 16 Mio de la file de réception du moteur. Le débit réel dépend du réseau, du navigateur et du disque.
- Conserve les contrôles du moteur V9/V10 : SHA-256 et CRC32 par bloc, validations, limite mémoire, stockage OPFS, reprise côté réception. Aucun nouveau code de vérification. Toute personne qui connaît le code de partage peut demander le fichier ; ne le diffuser qu'aux destinataires souhaités.
- Configuration STUN Google/Cloudflare issue de la V9, sans TURN. CSP conservée, retrait des directives non applicables via une balise meta. La CSP autorise encore les scripts inline et les bibliothèques CDN existantes ; ce n'est pas un audit de sécurité exhaustif.
- Nouveau cache PWA versionné V11. Historique local conservé lors de la mise à jour normale.

## Installation

Remplacer ensemble les fichiers à la racine de la branche GitHub Pages : `index.html`, `robust-transfer.js`, `storage-worker.js`, `sw.js`. Conserver manifeste, icônes et fichier de vérification Google. Le dossier `tests/` et le README sont facultatifs pour le fonctionnement du site. Après publication, attendre la fin du déploiement GitHub Pages, puis recharger sur les deux appareils. Si la V10 est encore affichée, fermer tous les onglets et l'application installée, rouvrir en ligne et actualiser (Ctrl+F5 sur ordinateur). Vérifier dans une fenêtre privée pour distinguer un problème de cache d'un problème de publication. Ne pas effacer le stockage du site si des fichiers partiels ou l'historique doivent être conservés. La V10 ayant un script invalide, son mécanisme de mise à jour côté page ne peut pas fonctionner ; le navigateur peut néanmoins mettre à jour le service worker déjà installé lors des navigations.

## Tests et limites

Node.js 22 : `node --test tests/test_syntax.mjs tests/test_engine.mjs tests/test_persistence.mjs` : 9 tests réussis, dont la nouvelle vérification de syntaxe du module intégré à index.html, l'intégrité des données, deux envois simultanés, la reprise et le rejet des données corrompues. En plus, les trois modes et la génération SVG des QR ont été testés dans Chromium avec le DOM réel, une signalisation simulée et un générateur QR de test. L'interface a également été testée sans les bibliothèques externes. La navigation HTTP(S) de l'environnement a été bloquée ; ces tests isolés ne vérifient pas le CDN réel, PeerJS en ligne, la caméra, la mise à jour PWA réelle ou le débit entre appareils. Le test navigateur réseau fourni dans `tests/test_browser.py` reste à exécuter sur une machine autorisant les connexions locales. Tester d'abord un petit fichier et un partage à plusieurs appareils avant d'utiliser les fichiers volumineux.

La reprise après fermeture du récepteur nécessite OPFS et que l'émetteur garde son partage ouvert. Le ZIP classique reste limité à environ 4 Go. Sans relais TURN, certaines configurations NAT et pare-feu empêchent le transfert direct. Aucun débit maximal ne peut être garanti.
