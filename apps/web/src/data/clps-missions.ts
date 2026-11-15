interface ClpsMission {
  provider: string;
  target: string;
  landingSite: string;
  outcome: string;
  payloads: { name: string; purpose: string }[];
  sources: { label: string; url: string }[];
}

export const clpsMissions: Readonly<Record<string, ClpsMission | undefined>> = {
  "im-1": {
    provider: "Intuitive Machines",
    target: "Malapert A",
    landingSite: "Crater near Malapert A",
    outcome: "Odysseus made the first soft landing under NASA’s CLPS program and delivered six NASA payloads. Lunar Reconnaissance Orbiter imagery identified the lander inside a crater.",
    payloads: [
      { name: "SCALPSS", purpose: "Camera system designed to study how exhaust disturbs lunar soil." },
      { name: "ROLSES", purpose: "Radio instrument designed to measure the electron environment just above the lunar surface." },
      { name: "Laser Retroreflector Array", purpose: "Reflectors that allow spacecraft to locate the lander with a laser." },
    ],
    sources: [
      { label: "NASA payloads", url: "https://science.nasa.gov/lunar-science/clps-deliveries/to2-im/" },
      { label: "NASA landing imagery", url: "https://www.nasa.gov/missions/lro/nasas-lro-images-intuitive-machines-odysseus-lander/" },
    ],
  },
  "im-2": {
    provider: "Intuitive Machines",
    target: "Mons Mouton · 84.7754° S, 29.1280° E",
    landingSite: "Crater near the center of Mons Mouton",
    outcome: "Athena touched down in a crater and came to rest on its side. NASA received some data before the mission ended early.",
    payloads: [
      { name: "TRIDENT", purpose: "A drill designed to bring material from below the surface up for analysis." },
      { name: "MSOLO", purpose: "A mass spectrometer designed to look for volatile compounds in material from the drill." },
      { name: "Laser Retroreflector Array", purpose: "Reflectors that allow spacecraft to locate the lander with a laser." },
    ],
    sources: [
      { label: "NASA PRIME-1 science", url: "https://science.nasa.gov/lunar-science/clps-deliveries/prime-1-im/" },
      { label: "NASA mission outcome", url: "https://www.nasa.gov/news-release/nasa-receives-some-data-before-intuitive-machines-ends-lunar-mission/" },
      { label: "NASA target coordinates", url: "https://ntrs.nasa.gov/api/citations/20260003150/downloads/MSolo%20PRIME-1%20overview%20and%20results%20-%20LSSW.pdf" },
    ],
  },
  "blue-ghost-m1": {
    provider: "Firefly Aerospace",
    target: "Mare Crisium",
    landingSite: "Mare Crisium, lunar near side",
    outcome: "Blue Ghost landed upright and operated for about 14 days. All ten NASA payloads activated and collected data.",
    payloads: [
      { name: "LISTER", purpose: "Probe that measured temperatures below the surface to study heat flow from the lunar interior." },
      { name: "Lunar PlanetVac", purpose: "Sampler that used compressed gas to collect lunar soil." },
      { name: "LEXI", purpose: "X-ray imager that observed how the solar wind interacts with Earth’s magnetic field." },
    ],
    sources: [
      { label: "NASA payloads", url: "https://www.nasa.gov/wp-content/uploads/2025/01/np-2025-01-001-jsc-clps-firefly-press-kit-screen-508-1-10-25-final.pdf" },
      { label: "NASA mission outcome", url: "https://www.nasa.gov/news-release/nasa-science-continues-after-fireflys-first-moon-mission-concludes/" },
    ],
  },
};
