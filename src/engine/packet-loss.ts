const PACKET_COUNT = 100;
const PACKET_BATCH = 10;
const BATCH_WAIT_MS = 10;
const LOSS_RESPONSES_WAIT_MS = 5000;
const LOSS_CONNECT_TIMEOUT_MS = 8000;

interface TurnIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isUdpCandidate(c: RTCIceCandidate): boolean {
  let proto = c.protocol ?? '';
  if (!proto && c.candidate) {
    const parts = c.candidate.split(' ');
    if (parts.length >= 3) proto = parts[2];
  }
  return proto.toLowerCase() === 'udp';
}

export async function measurePacketLoss(): Promise<number | null> {
  let iceServers: TurnIceServer[];
  try {
    const res = await fetch('/api/turn-credentials', {
      method: 'POST',
      cache: 'no-store',
    });
    if (!res.ok) return null;
    iceServers = (await res.json()) as TurnIceServer[];
    if (!Array.isArray(iceServers) || iceServers.length === 0) return null;
  } catch {
    return null;
  }

  return new Promise<number | null>((resolve) => {
    const config: RTCConfiguration = {
      iceServers,
      iceTransportPolicy: 'relay',
    };
    const sender = new RTCPeerConnection(config);
    const receiver = new RTCPeerConnection(config);
    const senderDc = sender.createDataChannel('pl', {
      ordered: false,
      maxRetransmits: 0,
    });

    let received = 0;
    let settled = false;
    let opened = false;
    let senderReady = false;
    let receiverReady = false;
    const pendingForReceiver: RTCIceCandidate[] = [];
    const pendingForSender: RTCIceCandidate[] = [];

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      try {
        sender.close();
        receiver.close();
        senderDc.close();
      } catch {}
      resolve(
        opened
          ? Math.max(0, Math.min(1, (PACKET_COUNT - received) / PACKET_COUNT))
          : null,
      );
    };

    const killer = setTimeout(
      finish,
      LOSS_CONNECT_TIMEOUT_MS +
        (PACKET_COUNT / PACKET_BATCH) * BATCH_WAIT_MS +
        LOSS_RESPONSES_WAIT_MS +
        2000,
    );

    const drainPending = (): void => {
      while (receiverReady && pendingForReceiver.length > 0) {
        receiver.addIceCandidate(pendingForReceiver.shift()!).catch(() => {});
      }
      while (senderReady && pendingForSender.length > 0) {
        sender.addIceCandidate(pendingForSender.shift()!).catch(() => {});
      }
    };

    receiver.ondatachannel = (e) => {
      e.channel.onmessage = () => received++;
    };
    sender.onicecandidate = (e) => {
      if (!e.candidate || !isUdpCandidate(e.candidate)) return;
      if (receiverReady) receiver.addIceCandidate(e.candidate).catch(() => {});
      else pendingForReceiver.push(e.candidate);
    };
    receiver.onicecandidate = (e) => {
      if (!e.candidate || !isUdpCandidate(e.candidate)) return;
      if (senderReady) sender.addIceCandidate(e.candidate).catch(() => {});
      else pendingForSender.push(e.candidate);
    };
    sender.oniceconnectionstatechange = (): void => {
      if (sender.iceConnectionState === 'failed') finish();
    };

    senderDc.onopen = async () => {
      opened = true;
      for (let i = 0; i < PACKET_COUNT; i++) {
        if (settled) return;
        senderDc.send(String(i));
        if ((i + 1) % PACKET_BATCH === 0) await sleep(BATCH_WAIT_MS);
      }
      setTimeout(finish, LOSS_RESPONSES_WAIT_MS);
    };

    sender
      .createOffer()
      .then((o) => sender.setLocalDescription(o))
      .then(() => receiver.setRemoteDescription(sender.localDescription!))
      .then(() => {
        receiverReady = true;
        drainPending();
        return receiver.createAnswer();
      })
      .then((a) => receiver.setLocalDescription(a))
      .then(() => sender.setRemoteDescription(receiver.localDescription!))
      .then(() => {
        senderReady = true;
        drainPending();
      })
      .catch(() => {
        if (!settled) {
          settled = true;
          clearTimeout(killer);
          try {
            sender.close();
            receiver.close();
          } catch {}
          resolve(null);
        }
      });
  });
}
