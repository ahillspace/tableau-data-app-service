import { ServiceClient } from "../src/sdk/index.js";

declare const EXAMPLE_CONFIGURATION: { serviceOrigin: string; appId: string; deploymentId: string };
const client = new ServiceClient(EXAMPLE_CONFIGURATION);
const status = document.getElementById("status")!;
function once(target: EventTarget, name: string): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Media event ${name} timed out`));
    }, 5000);
    const done = (event: Event) => {
      cleanup();
      resolve(event);
    };
    const error = () => {
      cleanup();
      reject(new Error(`Media failed while waiting for ${name}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      target.removeEventListener(name, done);
      target.removeEventListener("error", error);
    };
    target.addEventListener(name, done, { once: true });
    target.addEventListener("error", error, { once: true });
  });
}
async function request(path: string, headers?: readonly (readonly [string, string])[]) {
  return client.request({
    providerRegistrationId: "slack",
    endpoint: "api",
    connectionId: (await client.connections({ provider: "slack" }))[0]!.id,
    method: "GET",
    path,
    ...(headers ? { headers } : {}),
  });
}
async function main() {
  await client.initialize();
  const image = document.createElement("img");
  image.alt = "Authenticated native image fixture";
  const imageResponse = await request("/image.png");
  if (imageResponse.status !== 200) throw new Error("Image request was not authorized");
  const imageUrl = URL.createObjectURL(await imageResponse.blob());
  image.src = imageUrl;
  document.body.append(image);
  await image.decode();
  if (image.naturalWidth !== 64 || image.naturalHeight !== 48)
    throw new Error("Authenticated image did not decode");
  URL.revokeObjectURL(imageUrl);

  const index: { ranges: [number, number][]; duration: number } = await (
    await fetch("/fixture/media-index")
  ).json();
  const video = document.createElement("video");
  video.muted = true;
  video.controls = true;
  video.width = 320;
  document.body.append(video);
  const media = new MediaSource(),
    mediaUrl = URL.createObjectURL(media);
  video.src = mediaUrl;
  await once(media, "sourceopen");
  const buffer = media.addSourceBuffer('video/webm; codecs="vp8"');
  const append = async (part: number) => {
    const [start, end] = index.ranges[part]!;
    const response = await request("/video.webm", [["Range", `bytes=${start}-${end}`]]);
    if (response.status !== 206 || !response.headers.get("content-range"))
      throw new Error("Native byte range was not preserved");
    // Each small native range is a standard initialization/Cluster segment, never a whole-video Blob.
    const bytes = await response.arrayBuffer();
    const updated = once(buffer, "updateend");
    buffer.appendBuffer(bytes);
    await updated;
  };
  await append(0);
  media.duration = index.duration;
  const loaded = once(video, "loadeddata");
  await append(1);
  await loaded;
  await video.play();
  const seeking = once(video, "seeking"),
    seeked = once(video, "seeked");
  video.currentTime = 2.2;
  await seeking;
  await append(3);
  await seeked;
  video.pause();
  if (video.videoWidth !== 160 || Math.abs(video.currentTime - 2.2) > 0.2)
    throw new Error("Native video did not render/seek");
  const direct = await fetch(
    `${EXAMPLE_CONFIGURATION.serviceOrigin}/v1/apps/one/proxy/slack/api/image.png`,
    { credentials: "include" },
  );
  if (direct.status !== 401)
    throw new Error("Ambient cookies unexpectedly authorized native navigation");
  await direct.body?.cancel();
  status.textContent = `Media passed: image ${image.naturalWidth}×${image.naturalHeight}; video ${video.videoWidth}×${video.videoHeight}; seek ${video.currentTime.toFixed(1)}s; unauthenticated navigation denied.`;
  const download = document.getElementById("download") as HTMLButtonElement;
  download.disabled = false;
  download.addEventListener("click", () => {
    void (async () => {
      const response = await request("/download.txt");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "sdk-authenticated-fixture.txt";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent += " Small authenticated download handed to browser.";
    })().catch((error) => {
      status.textContent = String(error);
    });
  });
  window.addEventListener("pagehide", () => {
    URL.revokeObjectURL(mediaUrl);
    client.close();
  });
}
void main().catch((error) => {
  status.textContent = `Media failed: ${error instanceof Error ? error.message : String(error)}`;
});
