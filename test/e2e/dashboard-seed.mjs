// Realistic demo books for the dashboard browser test (and for before/after screenshots). Amounts are invented.
export const SEED = () => {
  const pad=n=>String(n).padStart(2,'0');
  const now=new Date(); const y=now.getFullYear(), m=now.getMonth()+1;
  const key=(back)=>{const d=new Date(y,m-1-back,1);return d.getFullYear()+'-'+pad(d.getMonth()+1);};
  const day=(back,dd)=>key(back)+'-'+pad(dd);
  const incomeRecv=[]; const expenses=[];
  for(let b=0;b<8;b++){
    incomeRecv.push({id:'sal'+b,type:'Salary',name:'Salary — Dialog Axiata',amount:385000,month:key(b),date:day(b,28),received:true});
    if(b%2===0) incomeRecv.push({id:'frl'+b,type:'Freelance',name:'Freelance — web design',amount:95000+b*3000,month:key(b),date:day(b,14),received:true});
    expenses.push({id:'g'+b,desc:'Keells Super — groceries',amount:42500+b*900,cat:'Groceries',month:key(b),date:day(b,6),recurring:false,completed:true,source:'manual'});
    expenses.push({id:'u'+b,desc:'CEB electricity',amount:11800+b*250,cat:'Utilities',month:key(b),date:day(b,10),recurring:true,completed:true,source:'manual'});
    expenses.push({id:'r'+b,desc:'Rent — Colombo 05',amount:95000,cat:'Housing',month:key(b),date:day(b,1),recurring:true,completed:true,source:'manual'});
    expenses.push({id:'t'+b,desc:'PickMe rides',amount:18300+b*400,cat:'Transport',month:key(b),date:day(b,18),recurring:false,completed:true,source:'statement'});
    expenses.push({id:'d'+b,desc:'Dinner — Ministry of Crab',amount:16800,cat:'Dining',month:key(b),date:day(b,21),recurring:false,completed:true,source:'statement'});
  }
  const iso=(d)=>d.toISOString().slice(0,10);
  const plus=(n)=>{const d=new Date();d.setDate(d.getDate()+n);return iso(d);};
  return {
    balance:{total:1284500,flows:[{id:'f1',type:'set',company:'Balance Set',amount:1284500,date:plus(-20),notes:'Opening'}]},
    income:[
      {id:'inv1',name:'Fixed Deposit — 12 mo',company:'Sampath Bank',amount:2500000,rate:11.5,start:'2026-01-05',end:'2027-01-05',freq:'monthly',day:'2026-01-05',monthly:23958,notes:'',duration:12,createdAt:new Date().toISOString()},
      {id:'inv2',name:'Treasury Bill 182d',company:'CBSL',amount:1000000,rate:9.8,start:'2026-06-01',end:'2026-12-01',freq:'monthly',day:'2026-06-01',monthly:8166,notes:'',duration:6,createdAt:new Date().toISOString()},
      {id:'inv3',name:'Land lease — Kandy',company:'Nimal Perera',amount:3200000,rate:14,start:'2025-09-01',end:'',freq:'monthly',day:'2025-09-01',monthly:37333,notes:'Paid by cheque',duration:36,createdAt:new Date().toISOString()},
    ],
    incomeRecv,
    incomeReceived:{},
    loans:[
      {id:'L1',name:'Honda Vezel — vehicle loan',bank:'HNB',start:'2025-03-01',duration:60,monthly:112400,amount:5200000,rate:12.5,paymentMethod:'emi',payments:[{month:key(1),paid:true,amount:112400,via:'other',paidAt:1},{month:key(2),paid:true,amount:112400,via:'other',paidAt:1}],skipped:[],purpose:'Vehicle',notes:''},
      {id:'L2',name:'Housing — Maharagama',bank:'Commercial Bank',start:'2024-01-01',duration:180,monthly:86300,amount:8400000,rate:10.2,paymentMethod:'emi',payments:[],skipped:[],purpose:'Home',notes:''},
    ],
    ccinstall:[{id:'C1',product:'MacBook Air M3',bank:'Sampath Bank',total:420000,rate:0,duration:12,monthly:35000,date:day(3,5),completed:false}],
    cconetime:[
      {id:'K1',desc:'Keells Super',amount:12400,combinedTotal:12400,serviceFee:0,bank:'Sampath Bank',type:'Credit Card',date:plus(-4),deadline:plus(11),paid:false},
      {id:'K2',desc:'Cinnamon Grand — dinner',amount:28900,combinedTotal:28900,serviceFee:0,bank:'HNB',type:'Credit Card',date:plus(-9),deadline:plus(6),paid:false},
      {id:'K3',desc:'Daraz',amount:7600,combinedTotal:7600,serviceFee:0,bank:'Sampath Bank',type:'Credit Card',date:plus(-20),deadline:plus(-2),paid:true},
    ],
    cheques:[
      {id:'Q1',no:'004512',party:'Kasun Traders',bank:'BOC',amount:150000,issue:plus(-10),release:plus(4),status:'pending',type:'received',notes:'Rent advance'},
      {id:'Q2',no:'118830',party:'Lanka Hardware',bank:'HNB',amount:64000,issue:plus(-3),release:plus(12),status:'pending',type:'issued',notes:''},
      {id:'Q3',no:'004377',party:'A. Silva',bank:'Sampath',amount:90000,issue:plus(-30),release:plus(-12),status:'cleared',type:'received',notes:''},
    ],
    expenses,
    targets:[
      {id:'T1',name:'Emergency fund',amount:1500000,start:'2026-01-01',end:'2026-12-31',savings:[{id:'s1',amount:250000,date:plus(-60),note:''},{id:'s2',amount:300000,date:plus(-20),note:''}]},
      {id:'T2',name:'Japan trip 2027',amount:900000,start:'2026-05-01',end:'2027-03-31',savings:[{id:'s3',amount:120000,date:plus(-30),note:''}]},
    ],
    subscriptions:[
      {id:'S1',name:'Netflix',amount:3990,cycle:'monthly',category:'Entertainment',dueDay:12,createdAt:'2026-01-05T00:00:00Z'},
      {id:'S2',name:'Dialog fibre',amount:6490,cycle:'monthly',category:'Utilities',dueDay:3,createdAt:'2026-01-05T00:00:00Z'},
      {id:'S3',name:'iCloud 2TB',amount:1750,cycle:'monthly',category:'Software',dueDay:20,createdAt:'2026-01-05T00:00:00Z'},
    ],
    debtors:[
      {id:'D1',name:'Nimal Perera',amount:450000,rate:0,start:day(2,5),notes:'',phone:'+94771234567',createdAt:new Date().toISOString(),payments:[{amount:100000,date:day(1,5)}]},
    ],
  };
};
