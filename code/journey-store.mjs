import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomBytes} from 'node:crypto';

// SQLite is for local/persistent-volume installations. Cloud Run must use the
// shared store; an ephemeral container filesystem is not durable storage.
export class SqliteJourneyStore {
 constructor(path){
  if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
  this.db=new DatabaseSync(path);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS journey_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS journeys(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT,updated_at TEXT NOT NULL,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS journey_events(journey_id TEXT NOT NULL,event_id TEXT NOT NULL,user_id TEXT NOT NULL,kind TEXT NOT NULL,received_at TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(journey_id,event_id));
   CREATE INDEX IF NOT EXISTS journey_events_user ON journey_events(user_id,received_at);`);
  this.db.prepare('INSERT OR IGNORE INTO journey_meta VALUES(?,?)').run('identity_key',randomBytes(32).toString('hex'));
  this.identityKey=this.db.prepare('SELECT value FROM journey_meta WHERE key=?').get('identity_key').value;
 }
 async load(id){const row=this.db.prepare('SELECT payload FROM journeys WHERE id=?').get(id);return row?JSON.parse(row.payload):null;}
 async mutate(id,fn,eventId){
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const row=this.db.prepare('SELECT payload FROM journeys WHERE id=?').get(id);
   const seen=eventId?!!this.db.prepare('SELECT 1 FROM journey_events WHERE journey_id=? AND event_id=?').get(id,eventId):false;
   const result=fn(row?JSON.parse(row.payload):null,seen);
   if(result.state){const s=result.state;this.db.prepare('INSERT INTO journeys VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload').run(id,s.user_id,s.conversation_id,s.updated_at,JSON.stringify(s));}
   for(const e of result.events??[])this.db.prepare('INSERT OR IGNORE INTO journey_events VALUES(?,?,?,?,?,?)').run(id,e.event_id,e.user_id,e.kind,e.received_at,JSON.stringify(e));
   this.db.exec('COMMIT');return result.value;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 events(id){return this.db.prepare('SELECT payload FROM journey_events WHERE journey_id=? ORDER BY rowid').all(id).map(x=>JSON.parse(x.payload));}
 close(){this.db.close();}
}
