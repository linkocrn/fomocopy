'use strict';

// FOMO leader wallets. The EVM address is the same on Robinhood Chain and Base.
//
// Note on these wallets: FOMO relays trades on the user's behalf, so the leader
// EOA never signs a transaction. Nonces sit at 2-6 and native balances at zero
// even for wallets trading six figures. Identify them by token flow, never by
// tx.from or nonce.
//
// The solana column is carried for later and is not used yet.
const LEADERS = [
  { handle: '0xAvast', evm: '0xcc0C581613DFd4ACe7c8686668427236f8BD5cC5', solana: '8xL8S7P4QLdTGRquHas8NP5EVjp2qUGbmSgrkh97mvmq' },
  { handle: 'Aurelius0121', evm: '0x0c175c6a0065ee05f871a68783d2de432a1e6cbe', solana: '9BMzTpSo4URse1oN666pmexhdjpU1vA5p7LtroCFQdLU' },
  { handle: 'AvgJoesCrypto', evm: '0x06dE9c48b1E639ED5C13eC8fBD4080a38E39f2D1', solana: null },
  { handle: 'Binkieee', evm: '0xd874259110C6E086F1d2feE474b73e69b8F5DAB0', solana: '6zMVSeukMUMKu5tDsECh4QMqrCRZqTbTvuawztFfwNti' },
  { handle: 'bluntz', evm: '0x551eE8420D4a1711E5f63EB47C532738940805c8', solana: null },
  { handle: 'boosteryting', evm: '0x5B30d0E72D624e0717D038A1982c88062C97dE9a', solana: 'EVqxB3F6iUBeWsTpBFQqWwxpqUS8s4NrzgxBvQ2VRbTq' },
  { handle: 'Burgz', evm: '0x8e4F5D00a5f4D7877A0f66B98FdF9d40323BC52A', solana: 'GFRjGNXY8JrGSPC46inqrH4XPdUFMDLkE1oNm1nXiPsJ' },
  { handle: 'CryptoTalkMan', evm: '0x94B65e74AfF27e819198Fc5837dC8dCEdC24043A', solana: '7jNRZuKsEXBEp8JSBbEKHsL42mw8WxveriEBthURg3oF' },
  { handle: 'DipWheeler', evm: '0x28A92fF139536c780b3D8B172E68bd2d32A666A6', solana: 'BMgsHTvcasRVtuevHJh8t6Vf5dmcWkDLAx6gSAQ3dsYm' },
  { handle: 'DumbCrayonEater', evm: '0x8F62A08537cede87D511AcA6436274Ab4Ca080a3', solana: '5FGoPPj1nL8LCnfVnpTmreqQtqLuMXXAwuS1uahMrp8V' },
  { handle: 'Ethermonk', evm: '0x2408cE75d217e3a70D6ca370c78C1B34D706F5a0', solana: '2xUbYAVq1oJGj45d6JjnaYHAke3NQecUcqWvvVbwmYw8' },
  { handle: 'fomopumpguy', evm: '0xb0E9DcCE59A1526c4277168a2505993D303f6060', solana: 'DAejzMs5cUeCCENNvapy9KWFwzwegh7LvcgNkZ6hnf1y' },
  { handle: 'FranktheGods', evm: '0x696d1265C8Fc4F14797aBEBFAe3C43EBFA9D8e28', solana: '498g1rVnFcnjBjpfw1xyqA1WvgQXUU8RWuELjxkjAayQ' },
  { handle: 'gr3gor14n', evm: '0x34568cB6bB15AfC4d314a88304B93B616DBDE77c', solana: 'J23qr98GjGJJqKq9CBEnyRhHbmkaVxtTJNNxKu597wsA' },
  { handle: 'jack7offsuit', evm: '0x8f2901c9636e228f8f1a6a6fcf96392294125612', solana: 'G3KKj95Z7hTxtB3XvZtvSzAUKW8Vwea6VJ2stBTJxwU8' },
  { handle: 'jotagezin', evm: '0xC1D4b5e64473fd90bF0390A1E0b61876064fd503', solana: '4hwPamSooBr5JhxHdcEC21HoxN5HUwYR2hGucLPyZAi8' },
  { handle: 'kyle', evm: '0x39B337121494b10CFfe3E581ab3281b2d62C5b08', solana: 'EJ1izM56eBS5baVLk7Q4iaQvsgCPa3W5bZgc44wwHz8U' },
  { handle: 'limfork', evm: null, solana: 'BQVz7fQ1WsQmSTMY3umdPEPPTm1sdcBcX9sP7o6kPRmB' },
  { handle: 'loganlim_x', evm: '0x8224c04a8f66557df682fd0581eb3724bd2bee07', solana: null },
  { handle: 'MachiBigBrother', evm: '0x3205c07Eb8D4f59fa709d64cA68c51D427094be4', solana: 'CvmrvyKfkJQtGNVKzaJ6H337CN9F2vxrLsZZnmjP2omq' },
  { handle: 'marcell', evm: '0x1978276BBB44d16f0d2e3e3Ea34f889e03b2ef86', solana: '6vbrTLsWy76TxDQAUKLqZrPohQuq6EVaJgfGzR82paFa' },
  { handle: 'MemeKingdom', evm: '0xDe7c85ed0520221b7d5802753366410fC8ebA6D7', solana: '2QQFwT3QV1LrH9vvaUiGjhpNCmGqVDxRAkmGKvjruBUS' },
  { handle: 'mitch', evm: null, solana: '4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t' },
  { handle: 'Oxmistblade', evm: null, solana: 'C7Ds4FQ1H9EnQrhNayFcs9wDb5t7HS8jrCh37Me9eYVy' },
  { handle: 'PoorGoat', evm: '0x9cE0cb4a193acbCE0DCa3283972341aed6F3F614', solana: 'HDixbrzwwLXczhDBk1JVrurPQsuLE8FUKnW2pucSXN3o' },
  { handle: 'Punter', evm: '0x5F1Fb9953d4D0664748A8419475Ea7593bEAeE3C', solana: 'BGSecfpdtCSa5xLfjYkmXKtzJgaUxpdLAsCiNkbxVm8o' },
  { handle: 'Qwerty', evm: '0x0121525f755c9e7bbC525bBA6672716AB46Ced57', solana: '8f39XhhZoRD8sYb6K5K9N7iSHXkL7BDmFFQNDF3TtsEr' },
  { handle: 'rasmr', evm: '0x2fbD041a069Bb3D7099D55179169091CfEeC4221', solana: '9CNyLECt2j8tnDhqxtjYk5HUhZ2b8Nwnyb7sfYN7vND2' },
  { handle: 'Rowdy', evm: '0x03bA951f72e59899Ac8Dab30cB5624dbE5D52Bb8', solana: 'CzU8MaRcwvwUoNkwJFLbvtFWJugcEXAhDDQqNFE4ybb7' },
  { handle: 'SerConnnor', evm: '0x2a6e104C7F076545590a72615ef8784774dF0449', solana: 'FZ8pXNZLxGNiyhMXgzS2ZeMzkxiFYse16WVS8XoJeBeZ' },
  { handle: 'SerAvocado', evm: '0x0e17Fc4E333958E7b259aB652f334B2f5BBdB27E', solana: '8RCEq8RrBJ1G6eji9vZqjtjQgkDjUHMysPtynZENWo7S' },
  { handle: 'slingoor', evm: '0x17E9D5945dcEa0e5f51e9915b78E3bE71ee0731B', solana: '5YRgrP3mjGzrzirYYN5HAQH19cTYREYwGxW6XRJQUzij' },
  { handle: 'smol_intern', evm: '0x194DB29F5bEBacF3201aBc9dbDda452116A3FF23', solana: 'mDR91ufq4S2uSHa9E2PYL7xg4LwcQXaQFP7YK864a1z' },
  { handle: 'sol_engineer', evm: '0x7a31001f1411fce8f0e928dee0685f9ecca1776a', solana: '4YxyRTLsK88uQ83bWoanu1x2FHo312b7JrcRqYPudD4p' },
  { handle: 'stigstigstig_', evm: '0x662053fD75f1f7da7e524d884b96552a13d2800B', solana: 'm4CkbwCZbbmEXB2EJhzQmAVX5LikLsyTozqwxXA9wEk' },
  { handle: 'The__Solstice', evm: '0xD1c77a04b87393E98A1220532e72e8f7d0A31c5A', solana: '4ugDhHJ8XDXAeABmrNmGffFaLbJb9BkPyiFGVSV9ocwo' },
  { handle: 'theveeman', evm: '0xa0670863BD5CD0D60022BaB2eed78E81e1A06bcE', solana: 'F5hkYsi8JxjyA2JHN5CA7MbnnhWubkXB2ZQB7Gkaxqs6' },
  { handle: 'unipcs', evm: '0x0a6EBEd0155EDB4b21D92AD02897A626CD90119E', solana: '2heJbC32Tpfcb3nbUb5ER61K11FGZVfVGtVnDm6LDogF' },
  { handle: 'Wood', evm: '0xb02208D1b27811480cF6171bCCC2b7af9513Cddb', solana: '7iPPqPyrqcmfenRs4xZ72ab4pyuUofXB5YaQB83WJmT9' },
  { handle: 'zinc', evm: null, solana: 'AK18Ru6UzvbhBWcfnhALuMM4hSXvyDCmvMkrZD3QQqrU' },
];

// The list mixes checksummed and lowercase addresses. Everything downstream
// compares lowercase, because a checksum mismatch in a log topic silently
// matches nothing rather than erroring.
const EVM_LEADERS = LEADERS.filter((l) => l.evm).map((l) => ({ ...l, evm: l.evm.toLowerCase() }));
const BY_EVM = new Map(EVM_LEADERS.map((l) => [l.evm, l.handle]));

module.exports = { LEADERS, EVM_LEADERS, BY_EVM };
