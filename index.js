import ethers from "ethers";
import BigNumber from "bignumber.js";
import fetch from "node-fetch";
import fs from 'fs';
import consoleStamp from 'console-stamp';
import { config } from "./config.js"
import { abi } from "./abi.js"

consoleStamp(console, { format: ':date(HH:MM:ss)' });

const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const explorer = {
    1: 'https://etherscan.io/tx/',
    5: 'https://goerli.etherscan.io/tx/',
    10: 'https://optimistic.etherscan.io/tx/',
    137: 'https://polygonscan.com/tx/',
    42161: 'https://arbiscan.io/tx/',
    421611: 'https://rinkeby-explorer.arbitrum.io/tx/'
}

const provider = new ethers.providers.JsonRpcProvider(config.rpc);
const parseFile = fileName => fs.readFileSync(fileName, "utf8").split('\n').map(str => str.trim()).filter(str => str.length > 10);
const generateRandomAmount = (min, max) => Math.random() * (max - min) + min;
const timeout = ms => new Promise(res => setTimeout(res, ms))
let retryMap = new Map()

async function checkAllowance(wallet, token, spender) {
    const tokenContract = new ethers.Contract(token, abi.erc20Token, provider)
    let allowedAmmount = await tokenContract.connect(wallet).allowance(wallet.address, spender)

    return allowedAmmount.toString()
}

async function getTokenBalance(wallet, token) {
    const tokenContract = new ethers.Contract(token.address, abi.erc20Token, provider)
    let balance = await tokenContract.balanceOf(wallet.address)

    return balance.toString()
}

async function approveToken(wallet, token, spender) {
    const tokenContract = new ethers.Contract(token, abi.erc20Token, provider)
    const symbol = await tokenContract.symbol();
    const maxInt = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    console.log(`Approving ${symbol} for ${spender}`);

    await tokenContract.connect(wallet).approve(spender, maxInt)

    let allowance = 0;
    while (allowance != maxInt) {
        await timeout(5000)
        allowance = await checkAllowance(wallet, token, spender)
    }

    return allowance.toString()
}

async function getTokenData(address, name = false) {
    let res = await fetch(`https://api.1inch.io/v5.0/${config.network}/tokens`).catch(err => console.log(err));
    let data = await res.json()

    if (!name) return data.tokens[address.toLowerCase()]

    for (let [address, info] of Object.entries(data.tokens)) {
        if (info.symbol.toLowerCase() === name.toLowerCase()) {
            return address
        }
    }

}

async function getGasLimit(wallet, to, data, amount, native) {
    return await wallet.estimateGas({
        to: to,
        data: data,
        value: native ? amount : 0, // if fromToken is eth or bnb or ht, value should be fromAmount
    }).catch(err => { throw new Error(`[GAS LIMIT ERROR] ${err.message}`) });
}

async function getInchSpenderContractAddress() {
    let res = await fetch(`https://api.1inch.io/v5.0/${config.network}/approve/spender`).catch(err => console.log(err));
    let data = await res.json()

    return data.address
}

function handleRetries(wallet) {
    let maxRetries = config.retries;
    let count = retryMap.get(wallet.address) + 1 || 1;
    retryMap.set(wallet.address, count);

    return count < maxRetries
}

async function inchSwap(wallet, from, to, amount, slippage = 1) {
    try {
        amount = ethers.utils.parseUnits(amount, from.decimals)

        if (!from.tags.includes('native')) {
            const inchApproveAddress = await getInchSpenderContractAddress();
            let allowance = await checkAllowance(wallet, from.address, inchApproveAddress);
            Number(allowance) < Number(amount) && await approveToken(wallet, from.address, inchApproveAddress);
        }

        const queryString = [
            `fromTokenAddress=${from.address}`,
            `toTokenAddress=${to.address}`,
            `amount=${amount.toString()}`,
            `fromAddress=${wallet.address}`,
            `slippage=${slippage}`
        ].join('&');

        let res = await fetch(`https://api.1inch.io/v5.0/${config.network}/swap?${queryString}`).catch(err => console.log(err));
        const response = await res.json();

        if (!response?.error) {
            console.log(`[1INCH] swap: ${amount / `1e${response.fromToken.decimals}`} ${response.fromToken.symbol}`
                + ` => ${(response.toTokenAmount / `1e${response.toToken.decimals}`)} ${response.toToken.symbol},`
                + ` rate: ${(response.toTokenAmount / `1e${response.toToken.decimals}`) / (amount / `1e${response.fromToken.decimals}`)}`
                + ` ${from.symbol}/${response.toToken.symbol}`
            );

            const gasLimit = await getGasLimit(wallet, response.tx.to, response.tx.data, amount, response.fromToken.tags.includes('native'));

            let swap = await wallet.sendTransaction({
                from: response.tx.from,
                to: response.tx.to,
                data: response.tx.data,
                value: response.fromToken.tags.includes('native') ? amount : 0,
                nonce: await wallet.getTransactionCount(),
                gasLimit: ethers.utils.hexlify(gasLimit),
                gasPrice: ethers.utils.hexlify(await wallet.getGasPrice()),
            }).catch(err => { throw new Error(err.code) })

            console.log(`Tx hash: ${explorer[config.network]}${swap.hash}`);

            await swap.wait()
        } else throw new Error(JSON.stringify(response));
    } catch (err) {
        console.log('[1INCH ERROR]', err.code);
        await timeout(15000)
        handleRetries(wallet) && await inchSwap(wallet, from, to, ethers.utils.formatUnits(amount, from.decimals), slippage = 1)
    }
}

async function dodoexSwap(wallet, from, to, amount, slippage = 1) {
    try {
        amount = ethers.utils.parseUnits(amount, from.decimals)

        const queryString = [
            `fromTokenAddress=${from.address}`,
            `fromTokenDecimals=${from.decimals}`,
            `toTokenAddress=${to.address}`,
            `toTokenDecimals=${to.decimals}`,
            `fromAmount=${amount}`,
            `slippage=${slippage}`,
            `userAddr=${wallet.address}`,
            `chainId=${config.network}`,
            `rpc=${config.rpc}`,
        ].join('&');

        let res = await fetch(`https://route-api.dodoex.io/dodoapi/getdodoroute?${queryString}`).catch(err => console.log(err));
        const response = await res.json();

        if (response?.data?.data) {
            if (!from.tags.includes('native')) {
                const dodoAproveAddress = response.data.targetApproveAddr;

                let allowance = await checkAllowance(wallet, from.address, dodoAproveAddress)
                Number(allowance) < Number(amount) && await approveToken(wallet, from.address, dodoAproveAddress)
            }

            console.log(`[DODOEX] swap: ${amount / `1e${from.decimals}`} ${from.symbol} => ${response.data.resAmount} ${to.symbol},`
                + ` rate: ${response.data.resPricePerFromToken} ${from.symbol}/${to.symbol}`
            );

            const gasLimit = await getGasLimit(wallet, response.data.to, response.data.data, amount, from.tags.includes('native'));

            let swap = await wallet.sendTransaction({
                from: wallet.address,
                to: response.data.to,
                data: response.data.data,
                value: from.tags.includes('native') ? amount : 0,
                nonce: await wallet.getTransactionCount(),
                gasLimit: ethers.utils.hexlify(gasLimit),
                gasPrice: ethers.utils.hexlify(await wallet.getGasPrice()),
            }).catch(err => { throw new Error(err.message) })

            console.log(`Tx hash: ${explorer[config.network]}${swap.hash}`);
            await swap.wait()
        } else throw new Error(response.data.msgError || response.data || response)
    } catch (err) {
        console.log('[DODO ERROR]', err.code);
        await timeout(20000)
        handleRetries(wallet) && await dodoexSwap(wallet, from, to, ethers.utils.formatUnits(amount, from.decimals), slippage = 1)
    }
}

async function getPoolImmutables(poolContract) {
    const [factory, token0, token1, fee, tickSpacing, maxLiquidityPerTick] = await Promise.all([
        poolContract.factory(),
        poolContract.token0(),
        poolContract.token1(),
        poolContract.fee(),
        poolContract.tickSpacing(),
        poolContract.maxLiquidityPerTick(),
    ])

    return {
        factory,
        token0,
        token1,
        fee,
        tickSpacing,
        maxLiquidityPerTick,
    }
}

async function uniSwap(wallet, from, to, amount, slippage = 1) {
    try {
        let symbol = config.network == 137 ? 'WMATIC' : 'WETH';
        let WETH = await getTokenData(null, symbol)

        from.address = from.tags.includes('native') ? WETH : from.address
        to.address = to.tags.includes('native') ? WETH : to.address
        console.log(WETH, 'asdsajasp');

        const factoryContractAddress = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
        const swapRouterAddress = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
        const quoterContractAddress = '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6';

        const factoryContract = new ethers.Contract(factoryContractAddress, abi.uniswap.factory, provider)
        const poolAddress = await factoryContract.getPool(from.address, to.address, 500);
        const poolContract = new ethers.Contract(poolAddress, abi.uniswap.pool, provider);
        console.log(poolAddress);
        const swapRouterContract = new ethers.Contract(swapRouterAddress, abi.uniswap.router, provider);
        const quoterContract = new ethers.Contract(quoterContractAddress, abi.uniswap.quoter, provider)

        let allowance = await checkAllowance(wallet, from.address, swapRouterAddress)
        Number(allowance) < Number(amount) && await approveToken(wallet, from.address, swapRouterAddress)

        let amountIn = ethers.utils.parseUnits(String(amount), from.decimals)
        const immutables = await getPoolImmutables(poolContract);
        const quotedAmountOut = await quoterContract.callStatic.quoteExactInputSingle(from.address, to.address, immutables.fee, amountIn, 0)
            .catch(err => { throw new Error(err.code) })

        console.log(`[UNISWAP] swap: ${amount} ${from.symbol}`
            + ` => ${quotedAmountOut.toString() / `1e${to.decimals}`} ${to.symbol},`
            + ` rate: ${(quotedAmountOut.toString() / `1e${to.decimals}`) / (amount)}`
            + ` ${from.symbol}/${to.symbol}`
        );

        if (quotedAmountOut && quotedAmountOut.toString() > 0) {
            const deadline = Math.floor(Date.now() / 1000) + (60 * 10);

            const params = {
                tokenIn: from.address,
                tokenOut: to.address,
                fee: immutables.fee,
                recipient: wallet.address,
                deadline: deadline,
                amountIn: amountIn,
                amountOutMinimum: quotedAmountOut.toString(),
                sqrtPriceLimitX96: 0,
            }

            let encData = swapRouterContract.interface.encodeFunctionData("exactInputSingle", [params])
            const encMultiCall = swapRouterContract.interface.encodeFunctionData("multicall(uint256 deadline,bytes[] data)", [deadline, [encData]])

            const gasLimit = await getGasLimit(wallet, swapRouterAddress, encMultiCall, amountIn, from.tags.includes('native'));

            const multicall = await wallet.sendTransaction({
                to: swapRouterAddress,
                data: encMultiCall,
                value: from.tags.includes('native') ? amountIn : 0,
                nonce: await wallet.getTransactionCount(),
                gasLimit: gasLimit,
                gasPrice: ethers.utils.hexlify(await wallet.getGasPrice()),
            }).catch(err => { throw new Error(err.code) })

            console.log(`Tx hash: ${explorer[config.network]}${multicall.hash}`);

            await multicall.wait()
        } else console.log(`Invalid receive amount`);
    } catch (err) {
        console.log('[UNISWAP ERROR]', err.message);
        await timeout(15000)
        handleRetries(wallet) && await uniSwap(wallet, from, to, amount, slippage = 1)
    }
}

function getAmount(balance, tokenSell) {
    if (config.amount.max && !tokenSell.tags.includes('native')) {
        return String(balance)
    }
    if (config.amount.percent) {
        let percent = generateRandomAmount(config.amount.from, config.amount.to)
        return String((balance * (percent / 100)).toFixed(config.amount.decimals))
    }
    return String((generateRandomAmount(config.amount.from, config.amount.to)).toFixed(config.amount.decimals))
}

function initDexes() {
    let dexes = [];
    config.dex["1inch"] && dexes.push(inchSwap)
    config.dex["dodoex"] && dexes.push(dodoexSwap)
    config.dex["uniswap"] && dexes.push(uniSwap)

    return dexes
}



(async () => {
    let privateKeys = parseFile('privateKeys.txt');
    let tokenSell = await getTokenData(config.token.from);
    let tokenBuy = await getTokenData(config.token.to);
    console.log(`Route: ${tokenSell.symbol} => ${tokenBuy.symbol}`);

    for (let i = 0; i < privateKeys.length; i++) {
        let privateKey = privateKeys[i]
        let wallet = new ethers.Wallet(privateKey, provider);
        let balance = await provider.getBalance(wallet.address);
        let balanceReadable = ethers.utils.formatUnits(balance).toString();

        console.log(`Wallet [${i + 1}] ${wallet.address}`);
        console.log(`Balance: ${balanceReadable} ${tokenSell.symbol}`);

        if (config.token.from.toLowerCase() !== ETH.toLowerCase()) {
            let tokenBalance = await getTokenBalance(wallet, tokenSell)
            console.log(`Token balance: ${BigNumber(tokenBalance / `1e${tokenSell.decimals}`).toFixed()} ${tokenSell.symbol}`);
            balanceReadable = ethers.utils.formatUnits(tokenBalance, tokenSell.decimals).toString();
        }

        let randomAmount = getAmount(balanceReadable, tokenSell)
        let args = [wallet, Object.assign({}, tokenSell), Object.assign({}, tokenBuy), randomAmount, +config.slippage]
        let dexes = initDexes();
        let randomDex = Math.floor(generateRandomAmount(0, dexes.length))

        if (+balanceReadable >= randomAmount && balanceReadable > 0 && randomAmount > 0) {
            if (dexes.length > 0) {
                let dex = dexes[randomDex]
                await dex.apply(null, args)
                await timeout(config.delay * 1000)
            } else { console.log('No dexes selected, recheck config'); return }
        } else console.log(`Insufficient funds, need ${args[3]}, have ${balanceReadable}`);

        console.log('-'.repeat(100));
    }
})()