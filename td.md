# Project: Build a Production-Grade Multi-Chain ERC-4337 Paymaster Infrastructure

## Objective
You are a **Principal Blockchain Infrastructure Engineer**, **Principal Backend Engineer**, and **Distributed Systems Architect** with decades of experience designing, building, securing, and operating high-scale blockchain infrastructure.

You have extensive expertise in:

* Solidity
* Ethereum protocol internals
* ERC-4337 Account Abstraction
* ERC-20 / ERC-721 / ERC-1155
* ERC-2612
* Permit2
* EIP-7702
* Multi-chain infrastructure
* High-performance backend systems
* Distributed systems
* Event-driven architectures
* Cloud-native infrastructure
* Kubernetes
* PostgreSQL
* Redis
* Observability
* Security engineering
* Cryptography
* DevOps
* Production operations

Your responsibility is to architect and implement this project as if it will become commercial blockchain infrastructure serving hundreds of thousands of wallets and millions of UserOperations.

Do not produce tutorial code.

Do not produce demo code.

Do not produce MVP code.

Do not produce proof-of-concept implementations.

Every architectural decision should prioritize:

* reliability
* maintainability
* scalability
* modularity
* observability
* extensibility
* security
* performance
* fault tolerance

Assume this system will eventually support:

* millions of wallets
* multiple EVM chains
* thousands of UserOperations per minute
* horizontal scaling
* zero-downtime deployments
* enterprise customers

Where multiple implementation approaches exist, choose the solution that would be used in production by experienced blockchain infrastructure teams and explain the trade-offs.

Whenever possible, design the system using clean architecture and domain-driven design principles.

Build a complete, production-ready ERC-4337 Paymaster infrastructure that I fully own and operate.

Do **not** integrate or depend on Pimlico, Alchemy, Biconomy, ZeroDev, or any hosted Paymaster service.

The entire stack must be self-hosted except for blockchain RPC providers (which should be abstracted).

This is not a demo.

Use production architecture, security, monitoring, testing, and documentation.

---

# Functional Requirements

The system must include:

* ERC-4337 Verifying Paymaster contracts
* Backend sponsorship service
* Signature verification
* Policy engine
* Admin API
* Public sponsorship API
* PostgreSQL persistence
* Redis caching/rate limiting
* Monitoring
* Docker deployment
* CI/CD pipeline
* Comprehensive tests

---

# Target Chains

Support:

* Ethereum Mainnet
* BNB Smart Chain
* Polygon
* Arbitrum
* Base
* Optimism

Each chain should have:

* independent Paymaster contract
* independent configuration
* independent deposit management

The backend must support adding additional EVM chains with configuration only.

---

# Smart Contracts

Implement production Solidity contracts.

Requirements:

* latest OpenZeppelin
* latest stable Solidity
* ERC-4337 compatible
* EntryPoint compatible
* Verifying Paymaster
* stake management
* deposit management
* ownership transfer
* emergency pause
* withdrawal
* replay protection
* signature expiration
* domain separation
* nonce protection

Implement:

validatePaymasterUserOp()

postOp()

deposit()

withdraw()

addStake()

unlockStake()

withdrawStake()

Events for every important action.

Use custom errors.

Gas optimized.

---

# Backend

Technology:

Node.js

TypeScript

NestJS

Viem

No ethers.js unless absolutely necessary.

Architecture:

Controllers

Services

Repositories

Domain layer

Policy Engine

Signature Engine

Chain Adapter

Database Layer

Redis Layer

Monitoring Layer

No monolithic code.

---

# Sponsorship API

POST

/paymaster/sponsor

Input:

UserOperation

chainId

entryPoint

sender

callData

callGasLimit

verificationGasLimit

preVerificationGas

maxFeePerGas

maxPriorityFeePerGas

paymasterAndData

signature

Return:

paymasterAndData

signature

expiration

verification metadata

Reject invalid requests.

---

# Policy Engine

Policies should be configurable.

Support:

Sponsor everyone

Allowlist

Blocklist

Daily spending caps

Per-wallet quota

Per-IP quota

Per-contract quota

Per-chain quota

Token ownership requirements

Contract allowlists

Method allowlists

Permit2 approval sponsorship

USDT approval sponsorship

PEPE sponsorship

SHIB sponsorship

UNI sponsorship

USDC sponsorship

Custom policy plugins

Policies must be hot reloadable.

---

# Token Support

Must sponsor transactions involving:

USDT

USDC

DAI

UNI

PEPE

SHIB

AAVE

WETH

Any ERC20

The token should never determine whether sponsorship is possible.

Policies determine sponsorship.

---

# Security

Implement:

JWT admin auth

API keys

Role-based permissions

Replay protection

Timestamp validation

Signature expiration

Nonce validation

Rate limiting

Redis abuse detection

Circuit breakers

Input validation

Request signing

Audit logging

SQL injection prevention

DOS protection

Blacklist engine

IP throttling

Secure secrets management

---

# Database

PostgreSQL

Tables:

users

wallets

sponsorships

transactions

chains

policies

api_keys

admins

audit_logs

token_configs

allowlists

blocklists

gas_usage

daily_limits

Indexes.

Foreign keys.

Migration scripts.

Seed scripts.

---

# Redis

Use Redis for:

rate limiting

nonce cache

policy cache

temporary signatures

lock management

distributed cache

---

# Monitoring

Prometheus

Grafana

OpenTelemetry

Health endpoints

Metrics:

gas sponsored

failed sponsorships

success rate

latency

chain status

RPC health

balance monitoring

EntryPoint deposits

Stake monitoring

Alerts for:

low deposits

RPC failures

high error rate

high latency

attack detection

---

# Admin Dashboard API

Endpoints:

Create policy

Update policy

Delete policy

View sponsorships

View balances

Deposit management

Stake management

Enable chain

Disable chain

View logs

View metrics

Rotate keys

Manage allowlists

Manage blocklists

---

# Chain Management

Abstract chain implementation.

Adding a chain should require only:

RPC

EntryPoint

Paymaster

Explorer

Native token

Chain ID

No code changes.

---

# Deposit Manager

Automatically monitor:

Paymaster deposits

Stake

Native token balances

Warn when below threshold.

Support automatic refill hooks.

---

# Testing

Unit tests

Integration tests

End-to-end tests

Forked chain tests

Property-based tests

Load testing

Fuzz testing

Target:

95%+ coverage.

---

# Documentation

Generate:

Architecture docs

Sequence diagrams

Deployment guide

Security guide

API documentation (OpenAPI)

Threat model

Runbooks

Disaster recovery

Maintenance guide

Developer guide

Operator guide

---

# DevOps

Docker

Docker Compose

GitHub Actions

Production Dockerfiles

Multi-stage builds

Environment validation

Secret management

Automatic migrations

Rolling deployment support

---

# Deliverables

Produce:

1. Solidity contracts

2. Backend

3. Database migrations

4. Docker setup

5. CI/CD

6. Tests

7. Monitoring

8. Documentation

9. Example frontend integration

10. SDK for dApps

---

# Frontend SDK

Provide a TypeScript SDK so any dApp can integrate with the Paymaster.

Example:

const paymaster = new PaymasterClient({
endpoint: "...",
chainId: 1,
});

const sponsorship = await paymaster.sponsor(userOperation);

No framework dependency.

---

# Code Quality

Strict TypeScript.

ESLint.

Prettier.

Conventional commits.

SOLID principles.

No duplicated logic.

No placeholder code.

No TODOs.

No mock implementations.

No fake signatures.

No dummy data.

No hardcoded secrets.

Everything production ready.

---

# Constraints

Do not use:

* Pimlico Paymaster
* Alchemy Paymaster
* Biconomy Paymaster
* ZeroDev Paymaster
* Dummy implementations
* Mock APIs
* Example-only code

Using open ERC-4337 reference contracts and specifications is acceptable.

Every component must be implemented as if it will be deployed into production.

Output the project incrementally with complete, compileable, tested code and documentation.
