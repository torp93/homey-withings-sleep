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

Du trenger en Withings-konto med en Sleep Analyzer satt opp i Withings-appen. Legg til enheten i Homey og logg inn hos Withings når du blir bedt om det. Det er alt.

Vil du heller bruke din egen Withings-applikasjon i stedet for den innebygde, kan du legge inn egne nøkler i appinnstillingene, med veiledning og en tilkoblingstest.

Kildekode og tekniske notater: https://github.com/torp93/homey-withings-sleep

Denne appen er ikke laget av eller tilknyttet Withings.
