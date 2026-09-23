import { prisma } from '~/db.server';

interface CountryCode {
  countryCode: string;
  restOfWorld: boolean;
}

interface Zone {
  name: string;
  countries: Array<{ code: CountryCode }>;
}

interface LocationGroupZone {
  zone: Zone;
}

interface ProfileLocationGroup {
  locationGroupZones: {
    nodes: LocationGroupZone[];
  };
}

interface DeliveryProfile {
  profileLocationGroups: ProfileLocationGroup[];
}

interface DeliveryZonesResponse {
  data?: {
    deliveryProfiles: {
      nodes: DeliveryProfile[];
    };
  };
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

export async function syncShippingZones(
  admin: { graphql: (query: string) => Promise<Response> },
  shopId: string
): Promise<{ added: number; updated: number }> {
  const query = `
    query DeliveryZones {
      deliveryProfiles(first: 20) {
        nodes {
          profileLocationGroups {
            locationGroupZones(first: 100) {
              nodes { zone { name countries { code { countryCode restOfWorld } } } }
            }
          }
        }
      }
    }
  `;

  const response = await admin.graphql(query);
  const json = (await response.json()) as DeliveryZonesResponse;

  // Controlla errori GraphQL (es. scope mancante)
  if (json.errors && json.errors.length > 0) {
    const accessDenied = json.errors.some(
      (e) => e.extensions?.code === 'ACCESS_DENIED' || e.message.includes('Access denied')
    );
    if (accessDenied) {
      throw new Error('Manca lo scope read_shipping');
    }
    throw new Error(`GraphQL error: ${json.errors[0].message}`);
  }

  if (!json.data) {
    throw new Error('Nessun dato nella risposta GraphQL');
  }

  // Aggrega le zone da tutti i profili
  const zoneMap = new Map<string, { countries: Set<string>; restOfWorld: boolean }>();

  for (const profile of json.data.deliveryProfiles.nodes) {
    for (const locationGroup of profile.profileLocationGroups) {
      for (const { zone } of locationGroup.locationGroupZones.nodes) {
        const existing = zoneMap.get(zone.name) || {
          countries: new Set<string>(),
          restOfWorld: false,
        };

        for (const { code } of zone.countries) {
          if (code.restOfWorld) {
            existing.restOfWorld = true;
          } else {
            existing.countries.add(code.countryCode);
          }
        }

        zoneMap.set(zone.name, existing);
      }
    }
  }

  // Leggi le zone esistenti per sapere quali sono nuove
  const existingZones = await prisma.shippingZone.findMany({
    where: { shopId },
    select: { zoneName: true },
  });
  const existingNames = new Set(existingZones.map((z) => z.zoneName));

  let added = 0;
  let updated = 0;
  const syncedAt = new Date();

  // Upsert ogni zona
  for (const [zoneName, { countries, restOfWorld }] of zoneMap.entries()) {
    const countriesArray = Array.from(countries).sort();
    const isNew = !existingNames.has(zoneName);

    await prisma.shippingZone.upsert({
      where: { shopId_zoneName: { shopId, zoneName } },
      create: {
        shopId,
        zoneName,
        countries: countriesArray,
        restOfWorld,
        rateType: 'linear',
        syncedAt,
      },
      update: {
        countries: countriesArray,
        restOfWorld,
        syncedAt,
      },
    });

    if (isNew) {
      added++;
    } else {
      updated++;
    }
  }

  return { added, updated };
}
