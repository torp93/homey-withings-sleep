Sengetilstedeværelse fra Withings Sleep Analyzer, laget for å tåle feilen som stille bryter sengeautomatiseringen.

Withings' varslings-API bruker et eget abonnement per datakategori. En app som abonnerer én gang ved paring og aldri sjekker igjen, slutter før eller siden å motta sengehendelser: abonnementene for å legge seg og stå opp faller bort, mens vektdata fortsetter å komme og innloggingen forblir gyldig. Alt ser friskt ut, men sengeutløserne fyrer aldri igjen, og ingenting melder fra om feil.

Denne appen verifiserer begge sengeabonnementene jevnlig og gjenoppretter dem som har forsvunnet. Abonnementstilstanden er en egen kapabilitet, slik at feilen blir synlig i stedet for stille, og et flytkort utløses hvis det skjer.

DETTE FÅR DU

- I sengen / ute av sengen, oppdatert i sanntid
- Leggetid og tidspunktet du stod opp
- Tid i sengen og tid ute av sengen, som løpende tellere
- Siste natt i sengen, én verdi per fullført natt
- Varslingsstatus, så du ser at forbindelsen er i orden

FLYTKORT

- Når noen legger seg i sengen
- Når noen står opp av sengen
- Når Withings-varslingsabonnementet mistes
- Og noen er / er ikke i sengen
- Forny Withings-varslingsabonnementet

OPPSETT

Denne appen krever mer av deg enn de fleste. Les dette før du installerer.

Du trenger en Withings-konto med en Sleep Analyzer, og du må registrere din egen gratis applikasjon hos Withings Partner Hub for å få klient-ID og hemmelighet. Sanntidshendelser krever i tillegg en webhook opprettet i Homeys utviklerverktøy. Begge deler legges inn i appens innstillinger, og innstillingssiden tar deg gjennom det steg for steg, med en tilkoblingstest til slutt.

Withings tillater ikke at en app som denne leverer med felles legitimasjon, så det finnes ingen vei utenom. Sett av et kvarter første gang. Når det er satt opp, trenger du ikke røre det igjen.

Kildekode og tekniske notater: https://github.com/torp93/homey-withings-sleep

Denne appen er ikke laget av eller tilknyttet Withings.
