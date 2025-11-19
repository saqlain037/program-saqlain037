"use client";

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { sha256 } from "@noble/hashes/sha256";
import { utf8ToBytes } from "@noble/hashes/utils";
import { Buffer } from "buffer";

export const TIP_JAR_PROGRAM_ID = new PublicKey(
  "Gu7sMSSwiYm4JhKisQxAEA8EyJhiKfE2WRQuPFiUjinK"
);

// 1 SOL = 1_000_000_000 lamports
export const LAMPORTS_PER_SOL = 1_000_000_000;

const textEncoder = new TextEncoder();

function getDiscriminator(ixName: string): Buffer {
  // Anchor: first 8 bytes of sha256("global:<name>")
  const preimage = `global:${ixName}`;
  const hash = sha256(utf8ToBytes(preimage));
  return Buffer.from(hash.slice(0, 8));
}

const DISC_INIT_VAULT = getDiscriminator("init_vault");
const DISC_SEND_TIP = getDiscriminator("send_tip");
const DISC_WITHDRAW = getDiscriminator("withdraw");

export function toLamports(sol: number): bigint {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

export function getVaultPda(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [textEncoder.encode("tip_vault"), owner.toBytes()],
    TIP_JAR_PROGRAM_ID
  );
}

// Helper to encode a u64 (little endian) from bigint
function u64ToBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let v = value;
  const mask = BigInt(0xff);

  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(v & mask);
    v = v >> BigInt(8);
  }

  return bytes;
}

async function sendIx(
  connection: Connection,
  wallet: WalletContextState,
  ix: TransactionInstruction
): Promise<string> {
  if (!wallet.publicKey) {
    throw new Error("Wallet not connected");
  }
  if (!wallet.signTransaction) {
    throw new Error("Wallet does not support signTransaction");
  }

  const tx = new Transaction().add(ix);
  tx.feePayer = wallet.publicKey;

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("finalized");
  tx.recentBlockhash = blockhash;

  let signed;
  try {
    signed = await wallet.signTransaction(tx);
  } catch (err: any) {
    console.error("signTransaction failed", err);
    throw new Error(err?.message ?? "Failed to sign transaction");
  }

  let sig: string;
  try {
    sig = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
  } catch (err: any) {
    console.error("sendRawTransaction failed", err);
    throw new Error(err?.message ?? "Failed to send transaction");
  }

  try {
    await connection.confirmTransaction(
      {
        signature: sig,
        blockhash,
        lastValidBlockHeight,
      },
      "confirmed"
    );
  } catch (err: any) {
    console.error("confirmTransaction failed", err);
    // Still return the signature so you can look it up in explorers if needed
    throw new Error(
      err?.message ?? `Transaction ${sig} may not have been confirmed`
    );
  }

  return sig;
}

// ----------------------
// On-chain actions
// ----------------------

export async function initVaultOnChain(
  connection: Connection,
  wallet: WalletContextState
) {
  if (!wallet.publicKey) throw new Error("Wallet not connected");

  const [vaultPda] = getVaultPda(wallet.publicKey);

  const ix = new TransactionInstruction({
    programId: TIP_JAR_PROGRAM_ID,
    keys: [
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    // init_vault has no args → just the 8-byte discriminator
    data: DISC_INIT_VAULT,
  });

  const signature = await sendIx(connection, wallet, ix);
  return { vaultPda, signature };
}

export async function sendTipOnChain(
  connection: Connection,
  wallet: WalletContextState,
  recipient: PublicKey,
  amountLamports: bigint
) {
  if (!wallet.publicKey) throw new Error("Wallet not connected");

  // Vault PDA is derived from recipient (the vault owner)
  const [vaultPda] = getVaultPda(recipient);

  const amountBytes = u64ToBytes(amountLamports);

  const data = new Uint8Array(DISC_SEND_TIP.length + amountBytes.length);
  data.set(DISC_SEND_TIP, 0);
  data.set(amountBytes, DISC_SEND_TIP.length);

  const ix = new TransactionInstruction({
  programId: TIP_JAR_PROGRAM_ID,
  keys: [
    { pubkey: vaultPda, isSigner: false, isWritable: true },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  // init_vault has no args → just the 8-byte discriminator
  data: DISC_INIT_VAULT,
});


  const signature = await sendIx(connection, wallet, ix);
  return { vaultPda, signature };
}

export async function withdrawOnChain(
  connection: Connection,
  wallet: WalletContextState,
  amountLamports: bigint
) {
  if (!wallet.publicKey) throw new Error("Wallet not connected");

  const [vaultPda] = getVaultPda(wallet.publicKey);

  const amountBytes = u64ToBytes(amountLamports);
  const data = Buffer.concat([DISC_WITHDRAW, Buffer.from(amountBytes)]);

  const ix = new TransactionInstruction({
    programId: TIP_JAR_PROGRAM_ID,
    keys: [
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    ],
    data,
  });

  const signature = await sendIx(connection, wallet, ix);
  return { vaultPda, signature };
}

