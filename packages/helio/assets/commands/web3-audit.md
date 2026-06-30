---
description: Smart contract security audit — 10 bug class checklist, Foundry PoC template. Usage: /web3-audit <contract.sol>
---

# /web3-audit

Smart contract security audit using the 10-bug-class methodology.

## Usage

```
!web3-audit VulnerableContract.sol
!web3-audit https://github.com/protocol/contracts
```

## Pre-Dive Kill Signals

Check BEFORE reading code:

```
1. TVL < $500K → max payout too low → SKIP
2. 2+ top-tier audits (Halborn, ToB, Cyfrin) → SKIP
3. Protocol < 500 lines → minimal surface → SKIP
4. max_payout = min(10% × TVL, cap) → if < $10K → SKIP
```

Only proceed if score >= 6/10.

## 10 Bug Classes

### 1. Accounting State Desynchronization (28% of Criticals)

```bash
grep -rn "totalSupply|totalShares|totalAssets" contracts/
```

Check: Early returns in claim/redeem — are ALL state vars updated?

### 2. Access Control (19% of Criticals)

```bash
grep -rn "function vote|function poke|function update" contracts/ -A2
```

Check: Do ALL sibling functions have the SAME modifiers?

### 3. Incomplete Code Path (17% of Criticals)

```bash
grep -rn "safeApprove|delete" contracts/
```

Check: Does B have reverse of ALL state changes in A?

### 4. Off-By-One (22% of Highs)

```bash
grep -rn "Period|Epoch|Deadline" contracts/ -A3 | grep "[<>][^=]"
```

For EVERY `if (A > B)`: What happens when A == B?

### 5. Oracle / Price Manipulation

```bash
grep -rn "latestRoundData|getPriceUnsafe" contracts/ -A5
```

Check: Staleness, Pyth confidence, TWAP > 1800s.

### 6. ERC4626 Vaults

Check: Does `mint()` call same validation as `deposit()`?

### 7. Reentrancy

```bash
grep -rn "\.call{value|safeTransfer" contracts/ -B10
```

Check: Effects after Interactions order (CEI)?

### 8. Flash Loan Oracle Manipulation

```bash
grep -rn "getReserves|slot0" contracts/ -A5
```

Check: Spot price from Uniswap reserves? → manipulatable.

### 9. Signature Replay

```bash
grep -rn "ecrecover|nonce" contracts/
```

Check: Signed hash includes nonce + chainId + contract address?

### 10. Proxy / Upgrade

```bash
grep -rn "initialize|delegatecall|EIP1967" contracts/
```

Check: `_disableInitializers()` in constructor?

## Foundry PoC Template

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
import "forge-std/Test.sol";
import "../src/VulnerableContract.sol";

contract ExploitTest is Test {
    VulnerableContract target;
    address attacker = makeAddr("attacker");

    function setUp() public {
        vm.createSelectFork("mainnet", BLOCK_NUMBER);
        target = VulnerableContract(TARGET_ADDRESS);
    }

    function test_exploit() public {
        vm.startPrank(attacker);
        // Execute exploit
        vm.stopPrank();
    }
}
```

Run: `forge test --match-test test_exploit -vvvv`