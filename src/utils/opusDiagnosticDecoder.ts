import type { VoiceReceiver } from "@discordjs/voice";
import type { TransformCallback } from "node:stream";
import prism from "prism-media";

type ReceiverDiagnostics = NonNullable<
  ReturnType<VoiceReceiver["packetDiagnostics"]["get"]>
>;

export class OpusDiagnosticDecoder extends prism.opus.Decoder {
  failedInput?: {
    opusPacketBytes: number;
    daveFooterCandidate: boolean;
    receiver?: ReceiverDiagnostics;
  };

  constructor(
    private readonly receiver: VoiceReceiver,
    options: ConstructorParameters<typeof prism.opus.Decoder>[0],
  ) {
    super(options);
  }

  override _transform(
    packet: Buffer,
    encoding: BufferEncoding,
    done: TransformCallback,
  ) {
    const receiver = this.receiver.packetDiagnostics.get(packet);
    super._transform(packet, encoding, (error, data) => {
      if (error) {
        this.failedInput = {
          opusPacketBytes: packet.length,
          // A candidate footer does not establish encrypted DAVE media.
          daveFooterCandidate:
            packet.length >= 13 &&
            packet[packet.length - 2] === 0xfa &&
            packet[packet.length - 1] === 0xfa &&
            packet[packet.length - 3] >= 12 &&
            packet[packet.length - 3] < packet.length,
          receiver,
        };
      }
      done(error, data);
    });
  }

  formatFailureDiagnostics(): string {
    const input = this.failedInput;
    const receiver = input?.receiver;
    return `opusPacketBytes=${input?.opusPacketBytes ?? "none"} daveFooterCandidate=${input?.daveFooterCandidate ?? "none"} connectionStatus=${receiver?.connectionStatus ?? "UNKNOWN"} networkingCode=${receiver?.networkingCode ?? "UNKNOWN"} daveSessionPresent=${receiver?.daveSessionPresent ?? "UNKNOWN"} daveNativeSessionPresent=${receiver?.daveNativeSessionPresent ?? "UNKNOWN"} daveReady=${receiver?.daveReady ?? "UNKNOWN"} daveProtocolVersion=${receiver?.daveProtocolVersion ?? "UNKNOWN"} daveDecryptDecision=${receiver?.daveDecryptDecision ?? "UNKNOWN"} daveTransitionAgoMs=${receiver ? (receiver.daveTransitionAgoMs ?? "none") : "UNKNOWN"}`;
  }
}
