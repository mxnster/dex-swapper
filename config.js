export const config = {
    amount: {
        from: 40, // random ammount/percent between this values
        to: 50,
        percent: true, // true, to get random ammount by percent of balance
        max: false, // true, if you want to swap whole token (only for non-ETH tokens!) balance
        decimals: 4
        /*  rounds random number to more human form
            increase this value if you set small amount above
            e.g. 1.2343247329 to 1.23 (decimals 2)
            e.g. 0.01489878 to 0.0148 (decimals 4)
        */
    },
    token: {
        from: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', // token contract address
        to: '0x7f5c764cbc14f9669b88837ca1490cca17c31607' // token contract address
    },
    slippage: 1,
    delay: 1, // delay between wallets in seconds
    retries: 5, // retries count in case of errors
    rpc: 'https://1rpc.io/op', // replace according to network! 
    network: 10,
    /**
     * Ethereum	1
     * Goerli	5
     * Optimism	10
     * Polygon	137 // currently uniswap doesn't work
     * Arbitrum One	42161
     * Arbitrum Rinkeby	421611
     */
    dex: {
        '1inch': 1, // set to 0 to disable dex
        'dodoex': 1,
        'uniswap': 1
    }
}